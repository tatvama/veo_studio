"""Run the Tatvam MCP server over stdio, for clients that start it as a command (Claude Desktop, Claude Code).

    cd backend
    set TATVAM_TOKEN=tvm_...          (a token from Settings → MCP access)
    .venv\\Scripts\\python -m app.mcp_server

It uses the same .env (database, storage) as the app. Paid jobs are queued in the database and run by the app's
worker, so keep the app running (port 8100). Most people should use the HTTP endpoint instead: http://localhost:8100/mcp
"""
from __future__ import annotations

import contextlib
import os
import sys


def main() -> None:
    if not os.environ.get("TATVAM_TOKEN", "").strip():
        print("Set TATVAM_TOKEN to a token from Tatvam → Settings → MCP access.", file=sys.stderr)
        sys.exit(2)
    with contextlib.redirect_stdout(sys.stderr):  # stdout carries the protocol: start-up messages go to stderr
        from ..db_migrate import migrate
        from .server import build

        migrate()
        server = build(with_auth=False)
    server.run("stdio")


if __name__ == "__main__":
    main()
