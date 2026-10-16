"""The public landing page: the waitlist (validation, de-duplication, the guard against floods, who may read it) and
the prices its cost estimator shows."""
from __future__ import annotations

import pytest
from conftest import H, ok
from fastapi.testclient import TestClient

from app import catalog
from app.api import waitlist
from app.core import rates
from app.db import SessionLocal
from app.models import AuditEntry, WaitlistEntry

JOIN = "/api/public/waitlist"
GOOD = {"email": "Asha.Rao@Example.com ", "phone": "98765 43210", "consent": True}


def wipe():
    with SessionLocal() as db:
        db.query(WaitlistEntry).delete()
        db.commit()
    waitlist.reset_for_tests()


@pytest.fixture
def anon(client):
    """A fresh client with no session cookie, on an empty waitlist (the `client` fixture is what creates the database)."""
    wipe()
    yield TestClient(client.app)
    wipe()


def rows() -> list[WaitlistEntry]:
    with SessionLocal() as db:
        return db.query(WaitlistEntry).order_by(WaitlistEntry.id).all()


@pytest.mark.parametrize("typed", [
    "9876543210", "98765 43210", "98765-43210", "+91 98765 43210", "+919876543210", "919876543210", "09876543210",
    "0091 98765 43210", "(+91) 98765.43210", "९८७६५४३२१०", "௯௮௭௬௫௪௩௨௧௦",  # Hindi and Tamil digits
])
def test_indian_numbers_become_e164(typed):
    assert waitlist.normalize_phone(typed) == "+919876543210"


@pytest.mark.parametrize("typed", [
    "", "   ", "abc", "12345", "5876543210", "98765432", "98765432100", "+91 5876543210", "+91 98765", "+0123456789",
    "+1234", "98765 43210 ext 4", "९८७६",
])
def test_bad_numbers_are_refused(typed):
    assert waitlist.normalize_phone(typed) is None


def test_other_countries_need_a_plausible_length():
    assert waitlist.normalize_phone("+1 (415) 555-0123") == "+14155550123"
    assert waitlist.normalize_phone("+44 7911 123456") == "+447911123456"
    assert waitlist.normalize_phone("+1 415") is None


@pytest.mark.parametrize("email,valid", [
    ("asha@example.com", True), ("asha.rao+films@mail.example.co.in", True), ("a@b.io", True),
    ("", False), ("asha", False), ("asha@", False), ("@example.com", False), ("asha@example", False),
    ("asha@@example.com", False), ("a..b@example.com", False), ("asha rao@example.com", False),
    ("=cmd|' /C calc'!A0@example.com", False), ("+asha@example.com", False), ("-asha@example.com", False),
    ("आशा@example.com", False), (("a" * 65) + "@example.com", False), ("a@" + ("b" * 250) + ".com", False),
])
def test_email_check(email, valid):
    assert waitlist.valid_email(email) is valid


def test_anyone_can_join_without_signing_in(anon):
    r = anon.post(JOIN, json=GOOD)  # no session, no X-Requested-With header
    assert r.status_code == 200 and r.json() == {"ok": True}
    [e] = rows()
    assert (e.email, e.phone) == ("asha.rao@example.com", "+919876543210")  # trimmed, lower-cased, E.164


def test_joining_twice_gives_the_same_answer_and_keeps_the_first_entry(anon):
    assert anon.post(JOIN, json=GOOD).json() == {"ok": True}
    again = anon.post(JOIN, json={**GOOD, "email": "asha.rao@example.com", "phone": "+91 91234 56789"})
    assert again.status_code == 200 and again.json() == {"ok": True}  # can't be used to find out who has joined
    [e] = rows()
    assert e.phone == "+919876543210"  # nobody can overwrite an entry by knowing the email


def test_bad_details_are_refused_and_nothing_is_kept(anon):
    r = anon.post(JOIN, json={**GOOD, "email": "not-an-email"})
    assert r.status_code == 400 and "email" in r.json()["detail"].lower()
    r = anon.post(JOIN, json={**GOOD, "phone": "12345"})
    assert r.status_code == 400 and "mobile number" in r.json()["detail"]
    r = anon.post(JOIN, json={**GOOD, "consent": False})
    assert r.status_code == 400 and "tick the box" in r.json()["detail"]
    r = anon.post(JOIN, json={"email": GOOD["email"], "phone": GOOD["phone"]})  # consent left out
    assert r.status_code == 400
    assert anon.post(JOIN, json={**GOOD, "email": "x" * 300 + "@example.com"}).status_code == 422  # absurdly long
    assert rows() == []


def test_a_bot_that_fills_the_hidden_field_is_told_it_worked_and_nothing_is_kept(anon):
    r = anon.post(JOIN, json={**GOOD, "website": "http://spam.example"})
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert rows() == []


def test_one_address_cannot_flood_the_form(anon):
    bad = {**GOOD, "phone": "12345"}
    for _ in range(waitlist.JOIN_MAX):
        assert anon.post(JOIN, json=bad).status_code == 400
    r = anon.post(JOIN, json=GOOD)
    assert r.status_code == 429 and "wait a few minutes" in r.json()["detail"]
    assert rows() == []
    # somebody else (another address) is not held up by it
    assert anon.post(JOIN, json=GOOD, headers={"x-forwarded-for": "203.0.113.9"}).status_code == 200
    assert len(rows()) == 1


def test_the_list_is_for_admins_only(client, anon):
    anon.post(JOIN, json=GOOD)
    for path in ("/api/admin/waitlist", "/api/admin/waitlist.csv"):
        assert anon.get(path).status_code == 401
    assert anon.delete("/api/admin/waitlist/1", headers=H).status_code == 401

    ok(client.post("/api/users", headers=H, json={"email": "creator.wl@test.local", "name": "C", "role": "creator", "password": "creator-pass-1"}))
    creator = TestClient(client.app)
    ok(creator.post("/api/auth/login", headers=H, json={"email": "creator.wl@test.local", "password": "creator-pass-1"}))
    assert creator.get("/api/admin/waitlist").status_code == 403
    assert creator.get("/api/admin/waitlist.csv").status_code == 403
    assert creator.delete("/api/admin/waitlist/1", headers=H).status_code == 403
    assert len(rows()) == 1  # still there


def test_admin_reads_the_list_newest_first_and_as_csv(client, anon):
    anon.post(JOIN, json=GOOD)
    anon.post(JOIN, json={"email": "meera@example.com", "phone": "+44 7911 123456", "consent": True})
    got = ok(client.get("/api/admin/waitlist"))
    assert got["total"] == 2
    assert [e["email"] for e in got["entries"]] == ["meera@example.com", "asha.rao@example.com"]
    assert got["entries"][1]["phone"] == "+919876543210" and got["entries"][1]["phone_display"] == "+91 98765 43210"
    assert ok(client.get("/api/admin/waitlist?limit=1"))["entries"][0]["email"] == "meera@example.com"
    assert ok(client.get("/api/admin/waitlist?limit=1&offset=1"))["entries"][0]["email"] == "asha.rao@example.com"

    r = client.get("/api/admin/waitlist.csv")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert "attachment" in r.headers["content-disposition"]
    lines = r.text.splitlines()
    assert lines[0] == "joined_utc,email,phone"
    assert lines[1].endswith(",asha.rao@example.com,+91 98765 43210")  # spaces keep a spreadsheet from turning it into 9.2E+11
    assert lines[2].endswith(",meera@example.com,+447911123456")


def test_admin_can_delete_an_entry_and_the_audit_log_keeps_no_details(client, anon):
    anon.post(JOIN, json=GOOD)
    [e] = rows()
    ok(client.delete(f"/api/admin/waitlist/{e.id}", headers=H))
    assert rows() == []
    assert client.delete(f"/api/admin/waitlist/{e.id}", headers=H).status_code == 404
    with SessionLocal() as db:
        entry = db.query(AuditEntry).filter(AuditEntry.action == "waitlist.delete").order_by(AuditEntry.id.desc()).first()
        assert entry.target == f"entry {e.id}" and "asha" not in str(entry.detail) and "asha" not in entry.target


def test_public_rates_for_the_cost_estimator(client, anon, monkeypatch):
    monkeypatch.setattr(rates.get_settings(), "usd_inr_rate", 96.5)  # pinned: no network
    r = anon.get("/api/public/rates")
    assert r.status_code == 200 and "max-age" in r.headers["cache-control"]
    body = r.json()
    assert body["usd_inr"] == 96.5
    tiers = {t["id"]: t for t in body["tiers"]}
    assert list(tiers) == ["saver", "balanced", "hero"]
    for tier, t in tiers.items():
        mode = catalog.QUALITY_MODES[tier]
        model = catalog.MODELS[mode["model_key"]]
        assert t["resolution"] == mode["resolution"]
        assert t["usd_per_second"] == catalog.PRICES["video_per_second"][model][mode["resolution"]]
    assert tiers["saver"]["usd_per_second"] < tiers["balanced"]["usd_per_second"] < tiers["hero"]["usd_per_second"]
