<!--
PR title = the squash commit on main = the CHANGELOG line. Use Conventional Commits:
  feat(scope): …   new feature         → minor release
  fix(scope): …    bug fix             → patch release
  perf / refactor / docs / build / ci / test / chore / revert
Add "!" (feat!: …) or a "BREAKING CHANGE:" line for breaking changes → major release.
-->

## What and why

<!-- What changes for the user or the team, and why. Link issues: "Closes #123". -->

## How it was tested

- [ ] `python scripts/dev/check.py` passes (backend lint + tests, frontend typecheck + build)
- [ ] Tried in the app on port 8100 (screenshots below for UI changes)
- [ ] Mock mode only / ran against real providers (say which, and the spend)

## Checklist

- [ ] No secrets: `.env`, keys and tokens are not in the diff or in screenshots
- [ ] New settings or env vars are in `.env.example` and the README configuration table
- [ ] Paid AI calls still go through the cost estimate / approval flow
- [ ] Database changes upgrade old databases on start (`db_migrate.py`)
- [ ] Docs updated (README, docs/*) where behaviour changed

## Screenshots

<!-- UI changes: before / after -->
