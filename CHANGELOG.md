# Changelog

All notable changes to Tatvam AI Studio. From 3.0.0 on, this file is written by
[release-please](https://github.com/googleapis/release-please) from the pull request titles
([Conventional Commits](https://www.conventionalcommits.org/)); see [CONTRIBUTING.md](CONTRIBUTING.md#releases).
Versions follow [Semantic Versioning](https://semver.org/).

## [3.0.0](https://github.com/tatvama/veo_studio/releases/tag/v3.0.0) (2026-10-10)

First tagged release. It gathers everything merged so far (pull requests #1–#13) and starts the automated
release pipeline.

### Features

* **scene continuity:** scene look anchor made first, shared scene look block, keyframe QC with one automatic retake, Enhance with the Pro image model, and approved keyframes feed later character references ([#12](https://github.com/tatvama/veo_studio/pull/12)) ([6500dfc](https://github.com/tatvama/veo_studio/commit/6500dfc))
* **mcp:** MCP server at `/mcp` (Streamable HTTP + stdio) exposing the whole film pipeline as tools, with personal tokens, OAuth for claude.ai connectors and spend-scoped approvals; scene-by-scene runner that carries continuity from clip to clip ([#11](https://github.com/tatvama/veo_studio/pull/11)) ([76fb1e7](https://github.com/tatvama/veo_studio/commit/76fb1e7))
* **providers:** blocked-shot recovery, Seedance-ready characters, Seedance audio-to-video / extend / 480p drafts, OpenRouter images, one card per model, spend safety (plan 19.1) ([#10](https://github.com/tatvama/veo_studio/pull/10)) ([5d74db0](https://github.com/tatvama/veo_studio/commit/5d74db0))
* **ui:** project workspace reorganised from 15 tabs into Overview + five numbered steps (Story, Cast, Shots, Edit, Deliver) ([#9](https://github.com/tatvama/veo_studio/pull/9)) ([78372f5](https://github.com/tatvama/veo_studio/commit/78372f5))
* **director:** Director chat agent on Claude Sonnet 5.5 through the Anthropic API; Gemini stays selectable ([#8](https://github.com/tatvama/veo_studio/pull/8)) ([9c3e721](https://github.com/tatvama/veo_studio/commit/9c3e721))
* **providers:** OpenRouter and BytePlus ModelArk (Seedance, Seedream) providers, character registration in the BytePlus asset library, cheapest-route routing ([#7](https://github.com/tatvama/veo_studio/pull/7)) ([6ab21d2](https://github.com/tatvama/veo_studio/commit/6ab21d2))
* **ops:** liveness and readiness health checks for Docker and Coolify, worker heartbeat ([#6](https://github.com/tatvama/veo_studio/pull/6)) ([c82b14a](https://github.com/tatvama/veo_studio/commit/c82b14a))
* **posters:** Poster Studio, a drag-and-drop poster editor with AI layers, templates and Indic display fonts ([#5](https://github.com/tatvama/veo_studio/pull/5)) ([95504bf](https://github.com/tatvama/veo_studio/commit/95504bf))
* **auth:** cinematic sign-in page with an AI showreel ([#4](https://github.com/tatvama/veo_studio/pull/4)) ([aefa3cc](https://github.com/tatvama/veo_studio/commit/aefa3cc))
* **ui:** "Command" dashboard redesign with light theme and rupees beside dollars ([#3](https://github.com/tatvama/veo_studio/pull/3)) ([79f54bd](https://github.com/tatvama/veo_studio/commit/79f54bd))
* **v3:** character-centred, Google-first production studio: Character Lock, versions, costumes, props, continuity bible, Google native dialogue route, change impact, dashboards, seasons, `@mentions` ([#2](https://github.com/tatvama/veo_studio/pull/2)) ([e6683e2](https://github.com/tatvama/veo_studio/commit/e6683e2))

### Bug Fixes

* **providers:** never skip BytePlus over a $0 cash balance (card billing and AI Savings Plans pay while prepaid cash reads $0) ([#13](https://github.com/tatvama/veo_studio/pull/13)) ([46a9539](https://github.com/tatvama/veo_studio/commit/46a9539))
* **db:** survive a flaky remote Postgres link (connect timeout, keepalives, retried reads) ([#4](https://github.com/tatvama/veo_studio/pull/4)) ([aefa3cc](https://github.com/tatvama/veo_studio/commit/aefa3cc))
* **storage:** Cloudflare R2 is the shared media store and local disk a read-through cache, so media made on another machine loads ([#1](https://github.com/tatvama/veo_studio/pull/1)) ([0f24e60](https://github.com/tatvama/veo_studio/commit/0f24e60))

### Build & Dependencies

* development pipeline: GitHub Actions CI (lint, 177 tests, typecheck, Docker smoke test), CodeQL, Dependabot, release-please releases with Docker images on GHCR, worktree and local-check scripts

## Before 3.0.0

Untagged. v1 was the first end-to-end pipeline (concept → hooks → script → bible → shots → keyframes → video →
lip-sync → music → export, with dubbing and the Director agent). v2 added the Model Hub (fal.ai catalog sync and
schema mapping), routing with fallbacks, shootouts, audio-driven dialogue, identity training, the writers' room,
review links, audit and brand kits. See [PLAN.md](PLAN.md) for the original plan.
