# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through
[GitHub → Security → Report a vulnerability](https://github.com/tatvama/veo_studio/security/advisories/new).
We aim to reply within 3 working days.

Include what an attacker can do, the steps to reproduce, and the version (`GET /api/health/live`).

## Supported versions

Only the latest release on `main` gets security fixes.

## How the project protects secrets

- `.env` is git-ignored; API keys saved in the app are encrypted with `APP_SECRET`.
- GitHub secret scanning with push protection blocks commits that contain known key formats.
- CodeQL scans the Python and TypeScript code on every pull request; Dependabot raises security updates.
- MCP tokens are stored as hashes; paid MCP tools only propose spending until a person (or a `spend`-scoped token) approves.
