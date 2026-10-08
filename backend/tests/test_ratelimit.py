"""Rate limits: Google 429 details are read, one 429 pauses the provider for every job, a rate-limited job waits in
the queue without using up a retry, and Veo calls are held back before Google's 10-minute spend cap."""
from __future__ import annotations

import time
from datetime import timedelta

import httpx
import pytest

from app.core import ratelimit
from app.db import SessionLocal, utcnow
from app.models import CostEntry, Job
from app.providers.base import RetryableProviderError, raise_for_status
from app.workers import worker as worker_mod

GOOGLE_429 = {"error": {
    "code": 429, "status": "RESOURCE_EXHAUSTED",
    "message": "You exceeded your current quota, please check your plan and billing details.",
    "details": [
        {"@type": "type.googleapis.com/google.rpc.QuotaFailure", "violations": [
            {"quotaMetric": "generativelanguage.googleapis.com/generate_requests_per_model",
             "quotaId": "GenerateRequestsPerMinutePerProjectPerModel", "quotaValue": "2"}]},
        {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "21s"},
    ]}}


@pytest.fixture(autouse=True)
def clean_backoff():
    yield
    ratelimit._until.clear()
    ratelimit._strikes.clear()


def test_google_429_details_are_kept():
    resp = httpx.Response(429, json=GOOGLE_429)
    with pytest.raises(RetryableProviderError) as ei:
        raise_for_status(resp, "gemini")
    e = ei.value
    assert e.rate_limited and e.retry_after == 21.0
    assert "GenerateRequestsPerMinutePerProjectPerModel (limit 2)" in str(e)
    assert str(e).index("quota:") < str(e).index("You exceeded")  # survives truncation in the UI


def test_retry_after_header_and_backoff():
    with pytest.raises(RetryableProviderError) as ei:
        raise_for_status(httpx.Response(429, headers={"retry-after": "7"}, json={"error": "Too Many Requests"}), "fal")
    assert ei.value.retry_after == 7.0
    # no hint: 60 s, doubling per strike; a success resets the strikes
    assert 59 < ratelimit.cool("google") <= 60
    # other jobs hitting the same limit during the pause are the same strike, not new ones
    assert 59 < ratelimit.cool("gemini") <= 60
    assert ratelimit._strikes.get("gemini") == 1
    ratelimit._until["gemini"] = 0  # the pause is over and the next call is limited again: a real second strike
    assert 119 < ratelimit.cool("gemini") <= 120  # google and gemini are the same provider
    assert ratelimit.cooling("google") > 100 and ratelimit.cooling("fal") == 0
    ratelimit.ok("google")
    assert ratelimit._strikes.get("gemini") is None


def test_spend_window(client, monkeypatch):
    monkeypatch.setattr(ratelimit.get_settings(), "gemini_spend_per_10min", 10.0)
    with SessionLocal() as db:
        db.query(CostEntry).filter(CostEntry.provider == "gemini", CostEntry.mock.is_(False)).delete()
        db.add(CostEntry(provider="gemini", model="veo", kind="video", usd=8.0, mock=False,
                         created_at=utcnow() - timedelta(minutes=4)))
        db.commit()
    try:
        assert ratelimit.google_spend_wait(0.4) == 0  # 8.4 fits under 9 (cap minus 10% margin)
        wait = ratelimit.google_spend_wait(1.5)  # 9.5 would cross 9: wait until the $8 ages out (~6 min)
        assert 300 < wait <= 360
        monkeypatch.setattr(ratelimit.get_settings(), "gemini_spend_per_10min", 0.0)
        assert ratelimit.google_spend_wait(5.0) == 0  # check turned off
    finally:
        with SessionLocal() as db:
            db.query(CostEntry).filter(CostEntry.provider == "gemini", CostEntry.mock.is_(False)).delete()
            db.commit()


def test_rate_limited_job_waits_without_using_a_retry(client):
    def limited(ctx):
        raise RetryableProviderError("gemini HTTP 429: quota", status=429, provider="gemini", retry_after=42)

    worker_mod.HANDLERS["_test_rate_limit"] = limited
    with SessionLocal() as db:
        j = Job(type="_test_rate_limit", status="running", attempts=1, max_attempts=3, payload={}, result={})
        db.add(j)
        db.commit()
        job_id = j.id
    try:
        worker_mod.Worker(concurrency=1).run(job_id)
        with SessionLocal() as db:
            j = db.get(Job, job_id)
            assert j.status == "queued" and j.attempts == 0  # the claim's attempt was given back
            assert j.result["rate_limit_waits"] == 1
            assert "Waiting for the gemini rate limit" in j.error
            assert 35 < (j.run_after - utcnow()).total_seconds() <= 42
            assert 35 < ratelimit.cooling("google") <= 42  # every other Google job is paused too
            j.status = "cancelled"  # keep the in-process worker from picking it up
            db.commit()
    finally:
        worker_mod.HANDLERS.pop("_test_rate_limit", None)
        time.sleep(0)
