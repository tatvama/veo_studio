# Changelog

All notable changes to Tatvam AI Studio. From 3.0.0 on, this file is written by
[release-please](https://github.com/googleapis/release-please) from the pull request titles
([Conventional Commits](https://www.conventionalcommits.org/)); see [CONTRIBUTING.md](CONTRIBUTING.md#releases).
Versions follow [Semantic Versioning](https://semver.org/).

## [3.4.0](https://github.com/tatvama/veo_studio/compare/v3.3.0...v3.4.0) (2026-10-18)


### Features

* **audio:** background sound under dialogue, free sound effects, music per scene and a lip-sync warning ([#63](https://github.com/tatvama/veo_studio/issues/63)) ([7e3b315](https://github.com/tatvama/veo_studio/commit/7e3b315a510e5192bc04d32978277096b2b56d67))
* **canvas:** a drag-node Shots screen — scene groups, shot steps, drag the cast onto shots, run with prices ([#64](https://github.com/tatvama/veo_studio/issues/64)) ([0674071](https://github.com/tatvama/veo_studio/commit/067407159c1a32a27730fa8740cbeba4179ebd66))
* **desktop:** the installed app connects to studio.taatvam.com by default ([#57](https://github.com/tatvama/veo_studio/issues/57)) ([fc1294e](https://github.com/tatvama/veo_studio/commit/fc1294e01791e67d59e2ef72e0841a4ac5a7218c))
* **flow:** one easy path — script box on Home, prices on every button, Make it for me, a Next bar and plain words ([#65](https://github.com/tatvama/veo_studio/issues/65)) ([d599b8c](https://github.com/tatvama/veo_studio/commit/d599b8cd0ef7b14d7be824a250afcc088c10804f))
* **produce:** voices that fit the cast, voice-over that fits its clip, a stop to check looks, scenes that join ([#62](https://github.com/tatvama/veo_studio/issues/62)) ([37a6fc6](https://github.com/tatvama/veo_studio/commit/37a6fc61b9cae9b74c9ec4262bd659d7ff452500))
* **screens:** Cast faces first, problems you can act on, try another engine, quick drafts, recipes and phone layouts ([#68](https://github.com/tatvama/veo_studio/issues/68)) ([43a7150](https://github.com/tatvama/veo_studio/commit/43a7150c6e0b65f8d8aea39ab084753e914ca9fd))


### Bug Fixes

* **continuity:** carry a script's cast, scene mood and sound through every shot, and finish the film's audio ([#60](https://github.com/tatvama/veo_studio/issues/60)) ([f3433be](https://github.com/tatvama/veo_studio/commit/f3433be6849dffc19675f15681065c6ce0b909a9))
* **desktop:** electron-builder 26 config for the Windows installer ([#58](https://github.com/tatvama/veo_studio/issues/58)) ([9ac5f2f](https://github.com/tatvama/veo_studio/commit/9ac5f2f2e83be465a3cc739fd2e81b3e5721f02e))
* **film:** screenplay speakers, narrator shots, no cut-off or made-up speech, outfit lines and a cleaner sound mix ([#67](https://github.com/tatvama/veo_studio/issues/67)) ([c99479c](https://github.com/tatvama/veo_studio/commit/c99479c39b7d8e4ecb5f465c29c46a89baea699d))
* **import:** read script lines with linear-time patterns ([#61](https://github.com/tatvama/veo_studio/issues/61)) ([ab55f19](https://github.com/tatvama/veo_studio/commit/ab55f190ae872104575d513182e91c92c56a3179))
* **runs:** runs list their problems, voices before videos, safer retakes and budget, redo after a character change ([#66](https://github.com/tatvama/veo_studio/issues/66)) ([02fa610](https://github.com/tatvama/veo_studio/commit/02fa6100b4018a835e549b458f48dd4fb7646564))

## [3.3.0](https://github.com/tatvama/veo_studio/compare/v3.2.0...v3.3.0) (2026-10-16)


### Features

* **frames:** start and end frames, synced clips and a Seedream frames engine ([#54](https://github.com/tatvama/veo_studio/issues/54)) ([746354b](https://github.com/tatvama/veo_studio/commit/746354bc909726bf6ad280a4dbec615a9f1e997b))

## [3.2.0](https://github.com/tatvama/veo_studio/compare/v3.1.0...v3.2.0) (2026-10-16)


### Features

* **cast:** character boards, one-request Seedream boards and a per-character image engine ([#51](https://github.com/tatvama/veo_studio/issues/51)) ([c79ad56](https://github.com/tatvama/veo_studio/commit/c79ad569ea7c62b4fa48d86454da346e55e33edb))
* **cast:** register AI-made character uploads with BytePlus, safely ([#49](https://github.com/tatvama/veo_studio/issues/49)) ([ab2bd9b](https://github.com/tatvama/veo_studio/commit/ab2bd9b35eecfd9465bf23b15b568a439da856d3))
* **director:** one long prompt with tagged pictures and [@mentions](https://github.com/mentions) ([#52](https://github.com/tatvama/veo_studio/issues/52)) ([b5b81cf](https://github.com/tatvama/veo_studio/commit/b5b81cf4ecefd20d08de51a4f56efff492770eb9))
* public landing page with a rupee cost estimator and a waitlist ([#53](https://github.com/tatvama/veo_studio/issues/53)) ([7634f12](https://github.com/tatvama/veo_studio/commit/7634f12b6b10d8e90c32cf960ac2d96b6e09be20))


### Bug Fixes

* **autopilot:** keep the user's script in the critic pass ([#48](https://github.com/tatvama/veo_studio/issues/48)) ([ae97461](https://github.com/tatvama/veo_studio/commit/ae9746169f6394d08604b1a22dc0a87fec507f05))
* **backend:** close review findings in auth, migrations, jobs and rendering ([#43](https://github.com/tatvama/veo_studio/issues/43)) ([ebc1b70](https://github.com/tatvama/veo_studio/commit/ebc1b707bad569a7702863836079df910d1f67fc))
* **byteplus:** don't send removal error text to the browser ([#50](https://github.com/tatvama/veo_studio/issues/50)) ([d2d4f53](https://github.com/tatvama/veo_studio/commit/d2d4f53145af4c6b05851c8dcfcf89e18bd61246))
* **desktop:** ffmpeg pipe hangs, trust boundaries and GPU gating ([#46](https://github.com/tatvama/veo_studio/issues/46)) ([0f8582e](https://github.com/tatvama/veo_studio/commit/0f8582e4450d6282fbccfc718c17a1a596c6e5e8))
* **director:** keep thread pictures as files, not base64 in the database ([#55](https://github.com/tatvama/veo_studio/issues/55)) ([39b3d1c](https://github.com/tatvama/veo_studio/commit/39b3d1cac9ac3d0d583ca548bade6e9a83b08adb))
* **engine:** decoder fallback, GPU leaks and bounded caches ([#45](https://github.com/tatvama/veo_studio/issues/45)) ([67a3388](https://github.com/tatvama/veo_studio/commit/67a3388eba0de51f587793116eaec02ddb4d95c1))
* **frontend:** guard paid actions, offline shell and lazy dictionaries ([#44](https://github.com/tatvama/veo_studio/issues/44)) ([5be2a4a](https://github.com/tatvama/veo_studio/commit/5be2a4a793853f6b37db46f791af58c4fbbd5656))

## [3.1.0](https://github.com/tatvama/veo_studio/compare/v3.0.0...v3.1.0) (2026-10-15)


### Features

* **desktop:** Tatvam Studio desktop finishing room (Phase 9, part 1) ([#28](https://github.com/tatvama/veo_studio/issues/28)) ([36ae2f9](https://github.com/tatvama/veo_studio/commit/36ae2f95ab647ccb498498f0e7b5a3fc5e45123a))
* **director:** agentic Director with plans, shot viewing, web search, memory and live progress ([#26](https://github.com/tatvama/veo_studio/issues/26)) ([fd73cf4](https://github.com/tatvama/veo_studio/commit/fd73cf4f918df460d2c1de9f11c4e019583fb041))
* **editor:** GPU render engine and Tatvam Editor for the desktop app ([#29](https://github.com/tatvama/veo_studio/issues/29)) ([9aad66a](https://github.com/tatvama/veo_studio/commit/9aad66ab7ddeee3077a81c455ca53225cf0d37d8))
* **editor:** News Room broadcast graphics with tickers, layouts, wipes, designers and exports ([#37](https://github.com/tatvama/veo_studio/issues/37)) ([4774986](https://github.com/tatvama/veo_studio/commit/477498626830218733263f3ff7aaab6983f94c24))
* **editor:** recorded sound effects from Kenney's CC0 packs ([#38](https://github.com/tatvama/veo_studio/issues/38)) ([7c1c83e](https://github.com/tatvama/veo_studio/commit/7c1c83e9b9fea647ed942fcca6926f0248bd6793))
* **editor:** sound effects library, auto SFX, real previews and a template design system ([#36](https://github.com/tatvama/veo_studio/issues/36)) ([c887192](https://github.com/tatvama/veo_studio/commit/c88719253db38054d5955c52a93a56e67f1b65ca))
* **ui:** spacious project layout and a focused shot-by-shot workspace ([#27](https://github.com/tatvama/veo_studio/issues/27)) ([028da12](https://github.com/tatvama/veo_studio/commit/028da12f9dc8d582607800e277f54e9558619be5))
* **writing:** Claude writes and reviews everything by default ([#25](https://github.com/tatvama/veo_studio/issues/25)) ([3867f0f](https://github.com/tatvama/veo_studio/commit/3867f0f4064dc1259bb22193c803792a185f58f5))


### Bug Fixes

* **editor:** News Room code-scanning findings (file reads, feed text, JSON paths) ([#40](https://github.com/tatvama/veo_studio/issues/40)) ([2907824](https://github.com/tatvama/veo_studio/commit/29078249c73794017d145c2deac793e3f19e6a86))
* **editor:** stop bitcrusher and lo-fi exports from turning samples into NaN ([#35](https://github.com/tatvama/veo_studio/issues/35)) ([433df75](https://github.com/tatvama/veo_studio/commit/433df75b3a82f82251d721a19865af78ed886a92))
* **providers:** name the missing BytePlus asset-library plan ([#24](https://github.com/tatvama/veo_studio/issues/24)) ([f4e6e9b](https://github.com/tatvama/veo_studio/commit/f4e6e9b47dea96845fa6aed042856490028332e0))


### Build & Dependencies

* **deps-dev:** bump @modelcontextprotocol/sdk from 1.30.1 to 1.31.0 in /desktop ([#31](https://github.com/tatvama/veo_studio/issues/31)) ([b2b0200](https://github.com/tatvama/veo_studio/commit/b2b0200360e4a13f6e66e0ed8fae7e35ec7458c0))
* **deps-dev:** bump @modelcontextprotocol/sdk in /desktop ([b2b0200](https://github.com/tatvama/veo_studio/commit/b2b0200360e4a13f6e66e0ed8fae7e35ec7458c0))
* **deps-dev:** bump ruff from 0.16.10 to 0.17.0 in /backend ([#33](https://github.com/tatvama/veo_studio/issues/33)) ([264946f](https://github.com/tatvama/veo_studio/commit/264946f55b7d013ebfda21814764c4868f2878b2))
* **deps:** bump konva from 9.3.22 to 10.7.1 in /frontend ([#41](https://github.com/tatvama/veo_studio/issues/41)) ([20035f3](https://github.com/tatvama/veo_studio/commit/20035f31e3a850f384a37b0b1361bb0faec681cc))
* **deps:** bump the npm-minor-patch group across 1 directory with 3 updates ([#17](https://github.com/tatvama/veo_studio/issues/17)) ([f8014ce](https://github.com/tatvama/veo_studio/commit/f8014cef1bded960a931f501542a10002745ee17))
* **deps:** bump the npm-minor-patch group in /frontend with 4 updates ([#34](https://github.com/tatvama/veo_studio/issues/34)) ([16aa64e](https://github.com/tatvama/veo_studio/commit/16aa64eba90fdab7a1662b41752ad0bbc25756b0))

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

* development pipeline: GitHub Actions CI (lint, 179 tests, typecheck, Docker smoke test), CodeQL, Dependabot, release-please releases with Docker images on GHCR, worktree and local-check scripts

## Before 3.0.0

Untagged. v1 was the first end-to-end pipeline (concept → hooks → script → bible → shots → keyframes → video →
lip-sync → music → export, with dubbing and the Director agent). v2 added the Model Hub (fal.ai catalog sync and
schema mapping), routing with fallbacks, shootouts, audio-driven dialogue, identity training, the writers' room,
review links, audit and brand kits. See [PLAN.md](PLAN.md) for the original plan.
