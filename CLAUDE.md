# Working in this repository

Tatvam AI Studio: FastAPI backend (`backend/`), React + Vite frontend (`frontend/`), one Docker image. Setup, env vars
and architecture: README.md. The development workflow: CONTRIBUTING.md.

## Workflow (follow it for every change)

- Work in a **new worktree and branch** per task, never on `main` in the main checkout (others often have
  uncommitted work there): `python scripts/dev/worktree.py new <type>/<topic>`. Claude Code worktrees in
  `.claude/worktrees/` are fine too.
- Use the shared backend venv of the main checkout (`<main checkout>/backend/.venv`); run `npm ci` per worktree,
  never link `node_modules`.
- Before pushing: `python scripts/dev/check.py` (ruff, pytest, `tsc -b` + vite build). All must pass.
- PR titles follow Conventional Commits (`feat(scope): …`, `fix: …`, `docs: …`, `chore: …`); PRs are
  squash-merged and the title becomes the changelog line. Ask before pushing, opening or merging PRs.
- Don't edit `CHANGELOG.md` released sections, `version.txt`, `.release-please-manifest.json` or the version in
  `backend/app/__init__.py` / `frontend/package.json`: release-please owns them.

## Code rules

- Never commit `.env` or keys. New settings go in `backend/app/config.py`, `.env.example` and the README tables.
- Tests run with mock providers (`backend/tests/conftest.py`) and must never call paid APIs.
- Paid work goes through jobs with estimates, budgets and approvals. "Google first" stays strict: no silent
  fallback spending on another provider.
- Database changes must auto-upgrade existing databases (`backend/app/db_migrate.py`).
- One server on port 8100 serves API + built frontend (`frontend/dist`); rebuild the frontend after UI changes and
  stop any throwaway test servers.
- New project pages go inside one of the five steps (`frontend/src/components/shell/nav.ts`), not new tabs.
- UI text is English only; don't add translation work.
