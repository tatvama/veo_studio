"""Retry reads that failed only because the database connection dropped.

With the database on another network, a pooled connection can die between requests (NAT timeout, mobile link hiccup).
The first request to use it then fails even though nothing is wrong. A GET or HEAD has no side effects, so if it failed
on a network error before any response bytes were sent, it is safe to run it once more on a fresh connection.
"""
from __future__ import annotations

import asyncio
import logging

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .db import is_network_error

log = logging.getLogger("retry")


class RetryReads:
    def __init__(self, app: ASGIApp, attempts: int = 2, delay_s: float = 0.25):
        self.app = app
        self.attempts = max(1, attempts)
        self.delay_s = delay_s

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("method") not in ("GET", "HEAD"):
            await self.app(scope, receive, send)
            return
        for attempt in range(1, self.attempts + 1):
            started = False

            async def tracked_send(message: Message) -> None:
                nonlocal started
                if message["type"] == "http.response.start":
                    started = True
                await send(message)

            try:
                await self.app(scope, receive, tracked_send)
                return
            except Exception as e:
                if started or attempt == self.attempts or not is_network_error(e):
                    raise
                log.warning("retrying %s %s after a database network error: %s", scope.get("method"), scope.get("path"), e)
                await asyncio.sleep(self.delay_s)
