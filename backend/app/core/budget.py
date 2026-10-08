"""Cost estimates, spend tracking, limits, approvals and alerts (PLAN §10 spend controls)."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import case, func
from sqlalchemy.orm import Session

from .. import catalog, settings_store
from ..db import utcnow
from ..events import emit
from ..models import Approval, CostEntry, Job, Project, Shot, User, role_rank
from ..pipeline.prompting import effective_quality, effective_voice_mode, shot_lines
from ..providers.base import Usage
from ..providers.services import provider_mode

RESERVING = ("queued", "running", "awaiting_approval")


def month_start(now: datetime | None = None) -> datetime:
    now = now or utcnow()
    return datetime(now.year, now.month, 1)


# ── estimates ────────────────────────────────────────────────────────────────

class Estimator:
    def __init__(self, db: Session):
        self.db = db
        self.models = settings_store.models(db)
        self.prices = settings_store.prices(db)
        self.settings = settings_store.all_settings(db)

    def _live(self, provider: str) -> bool:
        return provider_mode(provider) == "live"

    def image(self, n: int = 1, hero: bool = False) -> float:
        if not self._live("gemini"):
            return 0.0
        return n * float(self.prices["image_each"].get(self.models["image_hero" if hero else "image"], 0.07))

    def video(self, shot: Shot, project: Project, quality: str | None = None, engine: str | None = None) -> float:
        from . import model_hub
        q = quality or effective_quality(shot, project)
        qm = catalog.QUALITY_MODES[q]
        vm = effective_voice_mode(shot, project)
        dialogue = vm == "audio_driven" and bool(shot_lines(shot, project.primary_language))
        chain = "dialogue" if dialogue else f"video.{q}"
        modes = ["a2v"] if dialogue else ["ref2v", "i2v", "t2v"]
        explicit = engine or (shot.engine if shot.engine and shot.engine != "auto" else None)
        choice = model_hub.first_choice(self.db, chain, modes, explicit)
        if choice is None and dialogue:
            choice = model_hub.first_choice(self.db, f"video.{q}", ["i2v", "t2v"], explicit)
        if choice is None:
            return 0.0
        m, _ = choice
        secs = model_hub.clamp_duration(m, shot.duration_s)
        if m.builtin and m.provider == "google" and (qm["resolution"] != "720p"):
            secs = 8
        return model_hub.price_for(m, seconds=secs, resolution=qm["resolution"])

    def engine_video(self, shot: Shot, project: Project, engine_id: str) -> float:
        from . import model_hub
        from ..models import AIModel
        m = self.db.get(AIModel, engine_id)
        if not m:
            return 0.0
        q = effective_quality(shot, project)
        return model_hub.price_for(m, seconds=model_hub.clamp_duration(m, shot.duration_s),
                                   resolution=catalog.QUALITY_MODES[q]["resolution"])

    def tts_provider(self, lang: str) -> str:
        return (self.settings.get("tts_provider_by_language") or {}).get(lang, "gemini")

    def _tts(self, provider: str, chars: int) -> float:
        if not chars or not self._live(provider):
            return 0.0
        return float(self.prices["tts_per_1k_chars"].get(provider, 0.05)) * chars / 1000

    def voice(self, shot: Shot, lang: str, provider: str | None = None) -> float:
        """Priced per line with the voice that will actually speak it (an ElevenLabs voice costs ~10x Gemini)."""
        narration = len((shot.narration or {}).get(lang, ""))
        if provider:
            return self._tts(provider, sum(len(l.get("line", "")) for l in shot_lines(shot, lang)) + narration)
        from ..models import Episode
        from ..pipeline.voice import voice_for
        ep = self.db.get(Episode, shot.episode_id)
        project = self.db.get(Project, ep.project_id) if ep else None
        if project is None:
            return self._tts(self.tts_provider(lang), sum(len(l.get("line", "")) for l in shot_lines(shot, lang)) + narration)
        total = 0.0
        for l in shot_lines(shot, lang):
            total += self._tts(voice_for(self.db, l.get("character_id"), lang, project)["provider"], len(l.get("line", "")))
        if narration:
            total += self._tts(voice_for(self.db, "NARRATOR", lang, project)["provider"], narration)
        return total

    def lipsync(self, shot: Shot, model: str | None = None) -> float:
        from . import model_hub
        from ..pipeline.selection import current
        vt = current(self.db, shot.id, "video")
        if (vt and (vt.params or {}).get("audio_driven")
                and settings_store.get_setting(self.db, "dub_method") == "regenerate"):
            # an audio-driven shot is dubbed by generating a new talking clip, not by a lip-sync pass
            choice = model_hub.first_choice(self.db, "dialogue", ["a2v"], model if model and ":" in model else None)
            return model_hub.price_for(choice[0], seconds=shot.duration_s) if choice else 0.0
        choice = model_hub.first_choice(self.db, "lipsync", ["lipsync"], model if model and ":" in model else None)
        if choice is None:
            return 0.0
        return model_hub.price_for(choice[0], seconds=shot.duration_s)

    def voicelock(self, shot: Shot) -> float:
        if not self._live("elevenlabs"):
            return 0.0
        mins = shot.duration_s / 60
        return (float(self.prices["sts_per_minute"].get("elevenlabs", 0.3)) +
                float(self.prices["isolation_per_minute"].get("elevenlabs", 0.3))) * mins

    def music(self, seconds: float) -> float:
        if not self._live("gemini"):
            return 0.0
        model = self.models["music_clip" if seconds <= 30 else "music"]
        return float(self.prices["music_each"].get(model, 0.1))

    def voice_design(self, provider: str) -> float:
        return float(self.prices["voice_design_each"].get(provider, 0.0)) if self._live(provider) else 0.0

    def omni(self, seconds: float = 8) -> float:
        if not self._live("gemini"):
            return 0.0
        return float(self.prices["video_per_second"].get(self.models["omni"], {}).get("720p", 0.1)) * seconds

    @staticmethod
    def needs_lipsync(shot: Shot, project: Project, lang: str) -> bool:
        if not shot_lines(shot, lang):
            return False
        vm = effective_voice_mode(shot, project, lang)
        return vm == "audio_first" or (vm in ("native", "voice_lock") and lang != project.primary_language)


# ── spend ────────────────────────────────────────────────────────────────────

def record_cost(db: Session, usage: Usage, *, user_id: int | None, project_id: int | None, job_id: int | None) -> CostEntry:
    e = CostEntry(user_id=user_id, project_id=project_id, job_id=job_id, provider=usage.provider, model=usage.model,
                  kind=usage.kind, units=usage.units, unit_type=usage.unit_type, usd=round(usage.usd, 5), mock=usage.mock)
    db.add(e)
    db.flush()
    if usage.usd > 0:
        check_alerts(db)
    return e


def spent(db: Session, *, user_id: int | None = None, project_id: int | None = None, since: datetime | None = None) -> float:
    q = db.query(func.coalesce(func.sum(CostEntry.usd), 0.0))
    if user_id is not None:
        q = q.filter(CostEntry.user_id == user_id)
    if project_id is not None:
        q = q.filter(CostEntry.project_id == project_id)
    if since is not None:
        q = q.filter(CostEntry.created_at >= since)
    return float(q.scalar() or 0.0)


def reserved(db: Session, *, user_id: int | None = None, project_id: int | None = None) -> float:
    # each job holds what it may still spend (never less than 0: a job that overran does not free others' room);
    # a running orchestrator holds nothing, its child jobs reserve their own cost
    left = case((Job.cost_estimate > Job.cost_actual, Job.cost_estimate - Job.cost_actual), else_=0.0)
    q = (db.query(func.coalesce(func.sum(left), 0.0)).filter(Job.status.in_(RESERVING))
         .filter(~((Job.status == "running") & Job.type.in_(("dub", "autopilot", "produce")))))
    if user_id is not None:
        q = q.filter(Job.requested_by == user_id)
    if project_id is not None:
        q = q.filter(Job.project_id == project_id)
    return max(float(q.scalar() or 0.0), 0.0)


def team_status(db: Session) -> dict[str, Any]:
    cap = float(settings_store.get_setting(db, "team_monthly_cap_usd") or 0)
    used = spent(db, since=month_start())
    res = reserved(db)
    return {"cap_usd": cap, "spent_usd": round(used, 4), "reserved_usd": round(res, 4),
            "remaining_usd": round(cap - used - res, 4) if cap else None,
            "pct": round(100 * used / cap, 1) if cap else 0}


def user_limit(db: Session, user: User) -> float | None:
    if user.monthly_limit_usd is not None:
        return user.monthly_limit_usd
    if user.role == "creator":
        return settings_store.get_setting(db, "creator_default_monthly_limit_usd")
    return None


def check(db: Session, user: User, project: Project | None, amount: float) -> dict[str, Any]:
    """Returns {ok, needs_role, reason}. Producers/admins skip personal & project limits but not the team cap."""
    if role_rank(user.role) < role_rank("creator"):
        return {"ok": False, "needs_role": None, "reason": f"Your role ({user.role}) cannot start generations."}
    if amount <= 0:
        return {"ok": True, "needs_role": None, "reason": ""}
    team = team_status(db)
    if team["cap_usd"] and team["spent_usd"] + team["reserved_usd"] + amount > team["cap_usd"]:
        return {"ok": False, "needs_role": "admin",
                "reason": f"Team monthly cap ${team['cap_usd']:.2f} would be exceeded "
                          f"(spent ${team['spent_usd']:.2f} + reserved ${team['reserved_usd']:.2f} + this ${amount:.2f})."}
    privileged = role_rank(user.role) >= role_rank("producer")
    if not privileged:
        lim = user_limit(db, user)
        if lim is not None:
            mine = spent(db, user_id=user.id, since=month_start()) + reserved(db, user_id=user.id)
            if mine + amount > lim:
                return {"ok": False, "needs_role": "producer",
                        "reason": f"Your monthly limit ${lim:.2f} would be exceeded (used ${mine:.2f} + this ${amount:.2f})."}
        if project and project.budget_cap_usd:
            pj = spent(db, project_id=project.id) + reserved(db, project_id=project.id)
            if pj + amount > project.budget_cap_usd:
                return {"ok": False, "needs_role": "producer",
                        "reason": f"Project budget ${project.budget_cap_usd:.2f} would be exceeded (used ${pj:.2f} + this ${amount:.2f})."}
    return {"ok": True, "needs_role": None, "reason": ""}


def request_approval(db: Session, *, batch_id: str, user: User, project: Project | None, amount: float, reason: str,
                     needs_role: str, summary: str) -> Approval:
    a = Approval(batch_id=batch_id, requested_by=user.id, project_id=project.id if project else None, amount_usd=amount,
                 reason=reason, needs_role=needs_role, summary=summary)
    db.add(a)
    db.flush()
    emit(db, project.id if project else None, "approval.requested",
         {"approval_id": a.id, "amount_usd": amount, "reason": reason, "summary": summary, "by": user.name or user.email,
          "needs_role": needs_role}, user_id=user.id, commit=False)
    return a


def check_alerts(db: Session) -> None:
    team = team_status(db)
    if not team["cap_usd"]:
        return
    thresholds = settings_store.get_setting(db, "alert_thresholds") or [50, 80, 100]
    key = utcnow().strftime("%Y-%m")
    sent = settings_store.get_setting(db, "alerts_sent") or {}
    done = set(sent.get(key, []))
    for t in sorted(thresholds):
        if team["pct"] >= t and t not in done:
            done.add(t)
            emit(db, None, "budget.alert", {"threshold": t, **team}, commit=False)
    if done != set(sent.get(key, [])):
        settings_store.set_setting(db, "alerts_sent", {key: sorted(done)})
