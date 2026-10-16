"""The public landing page: its waitlist, and the prices its cost estimator shows.

No sign-in: POST /api/public/waitlist (ask for an invite with an email and a mobile number) and GET /api/public/rates.
Admins only: GET /api/admin/waitlist (+ .csv) to read the list, DELETE /api/admin/waitlist/{id} when someone asks to be removed.
"""
from __future__ import annotations

import csv
import io
import re
import threading
import time
import unicodedata
from collections import deque

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import catalog, settings_store
from ..core import rates
from ..core.audit import audit, client_ip
from ..db import get_db
from ..models import User, WaitlistEntry
from ..security import require
from .common import get_or_404

router = APIRouter(prefix="/api", tags=["waitlist"])

EMAIL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._%+-]*@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}")


def valid_email(email: str) -> bool:
    """Plain ASCII addresses only. The first character is a letter or digit, so an address never starts with = + - @,
    which a spreadsheet would run as a formula when an admin opens the CSV."""
    return len(email) <= 254 and len(email.partition("@")[0]) <= 64 and ".." not in email and bool(EMAIL_RE.fullmatch(email))


def _ascii_digits(s: str) -> str:
    """Native digits (९८७६…, ௯௮௭…) become 0-9, so a phone keyboard set to Hindi, Tamil, Telugu or Kannada just works."""
    return "".join(str(unicodedata.digit(c)) if unicodedata.category(c) == "Nd" else c for c in s)


def normalize_phone(raw: str) -> str | None:
    """E.164 (+, country code, number) from whatever was typed, or None. A number with no country code is Indian: a
    10-digit mobile starting 6-9, with or without 0 or 91 in front. Other countries only need a plausible length."""
    s = re.sub(r"[\s\-.()]", "", _ascii_digits(raw))
    if s.startswith("00"):  # 0091 98765 43210
        s = "+" + s[2:]
    if s.startswith("+"):
        digits = s[1:]
        if not re.fullmatch(r"[1-9][0-9]{7,14}", digits):
            return None
        if digits.startswith("91") and not re.fullmatch(r"91[6-9][0-9]{9}", digits):
            return None
        return "+" + digits
    if not re.fullmatch(r"[0-9]+", s):
        return None
    if len(s) == 12 and s.startswith("91"):
        s = s[2:]
    elif len(s) == 11 and s.startswith("0"):
        s = s[1:]
    return "+91" + s if re.fullmatch(r"[6-9][0-9]{9}", s) else None


def display_phone(e164: str) -> str:
    """+919876543210 → +91 98765 43210. With the spaces a spreadsheet keeps it as text instead of 9.2E+11."""
    return f"+91 {e164[3:8]} {e164[8:]}" if re.fullmatch(r"\+91[0-9]{10}", e164) else e164


# Public form, so cap how often one address may try (a mistyped form takes a few goes). In memory: it resets on restart,
# which is fine for a guard against floods rather than a quota.
JOIN_WINDOW_S = 600
JOIN_MAX = 8
_tries: dict[str, deque[float]] = {}
_tries_lock = threading.Lock()


def _too_many(key: str) -> bool:
    now = time.monotonic()
    with _tries_lock:
        if len(_tries) > 5000:  # forget the addresses that went quiet
            for k in [k for k, q in _tries.items() if not q or now - q[-1] > JOIN_WINDOW_S]:
                del _tries[k]
        q = _tries.setdefault(key, deque())
        while q and now - q[0] > JOIN_WINDOW_S:
            q.popleft()
        if len(q) >= JOIN_MAX:
            return True
        q.append(now)
        return False


def reset_for_tests() -> None:
    with _tries_lock:
        _tries.clear()


class JoinIn(BaseModel):
    email: str = Field(max_length=254)
    phone: str = Field(max_length=40)
    consent: bool = False
    website: str = Field(default="", max_length=200)  # honeypot: hidden in the form, so only a bot fills it in


@router.post("/public/waitlist")
def join_waitlist(body: JoinIn, request: Request, db: Session = Depends(get_db)):
    if _too_many(client_ip(request) or "unknown"):
        raise HTTPException(429, "Too many tries from this connection. Please wait a few minutes and try again.")
    if body.website.strip():
        return {"ok": True}  # a bot: look like it worked, keep nothing
    email = body.email.strip().lower()
    if not valid_email(email):
        raise HTTPException(400, "That doesn't look like an email address.")
    phone = normalize_phone(body.phone)
    if not phone:
        raise HTTPException(400, "Enter a valid mobile number, like 98765 43210.")
    if not body.consent:
        raise HTTPException(400, "Please tick the box so we can contact you about the launch.")
    # The answer is the same whether the address is new or already on the list, so the form can't be used to find out
    # who has joined. The first details stay: nobody can overwrite someone else's entry.
    if db.query(WaitlistEntry.id).filter(WaitlistEntry.email == email).first() is None:
        db.add(WaitlistEntry(email=email, phone=phone))
        try:
            db.commit()
        except IntegrityError:  # the same address joined in parallel
            db.rollback()
    return {"ok": True}


@router.get("/public/rates")
def public_rates(response: Response, db: Session = Depends(get_db)):
    """What the landing page's cost estimator needs: the price of one second of video in each quality tier (the same
    prices the studio estimates with, including the admin's overrides) and the USD→INR rate (null until a source answers)."""
    models = settings_store.models(db)
    per_second = settings_store.prices(db)["video_per_second"]
    tiers = []
    for tier, mode in catalog.QUALITY_MODES.items():
        usd = per_second.get(models.get(mode["model_key"], ""), {}).get(mode["resolution"])
        if usd:
            tiers.append({"id": tier, "resolution": mode["resolution"], "usd_per_second": float(usd)})
    response.headers["Cache-Control"] = "public, max-age=300"
    return {"tiers": tiers, "usd_inr": rates.usd_inr()["rates"].get("INR")}


@router.get("/admin/waitlist")
def list_waitlist(limit: int = 200, offset: int = 0, admin: User = Depends(require("admin")), db: Session = Depends(get_db)):
    """Newest first. `total` is the whole list; the CSV has every row."""
    q = db.query(WaitlistEntry)
    rows = q.order_by(WaitlistEntry.id.desc()).offset(max(0, offset)).limit(max(1, min(limit, 1000))).all()
    return {"total": q.count(), "entries": [e.to_dict(phone_display=display_phone(e.phone)) for e in rows]}


@router.get("/admin/waitlist.csv")
def waitlist_csv(admin: User = Depends(require("admin")), db: Session = Depends(get_db)):
    # Emails and numbers are validated on the way in (see valid_email, normalize_phone), so no cell can start with a
    # spreadsheet formula character.
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["joined_utc", "email", "phone"])
    for e in db.query(WaitlistEntry).order_by(WaitlistEntry.id):
        w.writerow([e.created_at.strftime("%Y-%m-%d %H:%M"), e.email, display_phone(e.phone)])
    return Response(out.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="tatvam-waitlist.csv"'})


@router.delete("/admin/waitlist/{entry_id}")
def delete_waitlist_entry(entry_id: int, request: Request, admin: User = Depends(require("admin")), db: Session = Depends(get_db)):
    e = get_or_404(db, WaitlistEntry, entry_id, "Waitlist entry")
    db.delete(e)
    # the id only: the person's details go away with the row
    audit(db, admin, "waitlist.delete", f"entry {entry_id}", request=request, commit=False)
    db.commit()
    return {"ok": True}
