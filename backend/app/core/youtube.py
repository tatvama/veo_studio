"""YouTube publishing + analytics (OAuth). Needs GOOGLE_CLIENT_ID/SECRET with the YouTube Data API and
YouTube Analytics API enabled in the same Google Cloud project. Instagram/others go through the Make.com webhook."""
from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy.orm import Session

from .. import settings_store
from ..config import get_settings
from ..models import Integration
from ..providers.base import ProviderError

SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly",
          "https://www.googleapis.com/auth/yt-analytics.readonly"]


def redirect_uri() -> str:
    return f"{get_settings().public_base_url.rstrip('/')}/api/integrations/youtube/callback"


def auth_url(state: str) -> str:
    from urllib.parse import urlencode
    s = get_settings()
    if not s.google_client_id:
        raise ProviderError("Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET to connect YouTube")
    return "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode({
        "client_id": s.google_client_id, "redirect_uri": redirect_uri(), "response_type": "code", "scope": " ".join(SCOPES),
        "access_type": "offline", "prompt": "consent", "state": state, "include_granted_scopes": "true"})


def _enc(data: dict) -> str:
    return settings_store._fernet().encrypt(json.dumps(data).encode()).decode()


def _dec(s: str) -> dict:
    return json.loads(settings_store._fernet().decrypt(s.encode()).decode())


def finish_connect(db: Session, code: str, user_id: int) -> Integration:
    s = get_settings()
    tok = httpx.post("https://oauth2.googleapis.com/token", data={
        "code": code, "client_id": s.google_client_id, "client_secret": s.google_client_secret,
        "redirect_uri": redirect_uri(), "grant_type": "authorization_code"}, timeout=30).json()
    if "access_token" not in tok:
        raise ProviderError(f"YouTube connect failed: {tok.get('error_description') or tok}")
    ch = httpx.get("https://www.googleapis.com/youtube/v3/channels", params={"part": "snippet", "mine": "true"},
                   headers={"Authorization": f"Bearer {tok['access_token']}"}, timeout=30).json()
    item = (ch.get("items") or [{}])[0]
    row = Integration(provider="youtube", account_name=item.get("snippet", {}).get("title", "YouTube channel"),
                      account_id=item.get("id", ""), secrets=_enc(tok), connected_by=user_id)
    db.add(row)
    db.commit()
    return row


def _access_token(db: Session, integ: Integration) -> str:
    s = get_settings()
    tok = _dec(integ.secrets)
    r = httpx.post("https://oauth2.googleapis.com/token", data={
        "client_id": s.google_client_id, "client_secret": s.google_client_secret, "refresh_token": tok.get("refresh_token", ""),
        "grant_type": "refresh_token"}, timeout=30).json()
    if "access_token" not in r:
        raise ProviderError("YouTube token expired — reconnect the channel in Settings → Integrations")
    return r["access_token"]


def upload(db: Session, integ: Integration, video: Path, title: str, description: str, tags: list[str],
           privacy: str = "unlisted", synthetic: bool = True, publish_at: str | None = None,
           thumbnail: Path | None = None) -> dict[str, Any]:
    token = _access_token(db, integ)
    status: dict[str, Any] = {"privacyStatus": privacy, "selfDeclaredMadeForKids": False, "containsSyntheticMedia": synthetic}
    if publish_at:  # YouTube only schedules private uploads; it makes them public at publishAt
        status.update(privacyStatus="private", publishAt=publish_at)
    meta = {"snippet": {"title": title[:100], "description": description[:4900], "tags": tags[:30], "categoryId": "24"},
            "status": status}
    init = httpx.post("https://www.googleapis.com/upload/youtube/v3/videos",
                      params={"uploadType": "resumable", "part": "snippet,status"},
                      headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                               "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": str(video.stat().st_size)},
                      content=json.dumps(meta), timeout=60)
    if init.status_code >= 400:
        raise ProviderError(f"YouTube upload init failed: {init.text[:300]}")
    loc = init.headers.get("Location")
    with open(video, "rb") as fh:
        r = httpx.put(loc, content=fh.read(), headers={"Content-Type": "video/mp4"}, timeout=1800)
    if r.status_code >= 400:
        raise ProviderError(f"YouTube upload failed: {r.text[:300]}")
    vid = r.json().get("id")
    out: dict[str, Any] = {"video_id": vid, "url": f"https://youtu.be/{vid}", "scheduled_for": publish_at}
    if thumbnail and thumbnail.is_file():
        # custom thumbnails need a verified channel; a refusal must not fail the upload
        ctype = "image/png" if thumbnail.suffix.lower() == ".png" else "image/jpeg"
        t = httpx.post("https://www.googleapis.com/upload/youtube/v3/thumbnails/set", params={"videoId": vid},
                       headers={"Authorization": f"Bearer {token}", "Content-Type": ctype},
                       content=thumbnail.read_bytes(), timeout=120)
        out["thumbnail"] = "set" if t.status_code < 400 else f"not set: {t.text[:160]}"
    return out


def metrics(db: Session, integ: Integration, video_id: str) -> dict[str, Any]:
    token = _access_token(db, integ)
    end = date.today()
    start = end - timedelta(days=90)
    h = {"Authorization": f"Bearer {token}"}
    base = {"ids": "channel==MINE", "startDate": start.isoformat(), "endDate": end.isoformat(), "filters": f"video=={video_id}"}
    totals = httpx.get("https://youtubeanalytics.googleapis.com/v2/reports", headers=h, timeout=30,
                       params={**base, "metrics": "views,likes,averageViewPercentage"}).json()
    row = (totals.get("rows") or [[0, 0, None]])[0]
    ret = httpx.get("https://youtubeanalytics.googleapis.com/v2/reports", headers=h, timeout=30,
                    params={**base, "metrics": "audienceWatchRatio", "dimensions": "elapsedVideoTimeRatio"}).json()
    return {"views": int(row[0] or 0), "likes": int(row[1] or 0), "avg_view_pct": row[2],
            "retention": [[float(a), float(b)] for a, b in (ret.get("rows") or [])]}
