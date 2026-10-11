# Tatvam Studio desktop (the finishing room)

The Electron app for the editors who finish a cut: local footage in series-named folders, 4K renders with hardware
encoding, pop-out monitors across screens, and cutting while offline. It runs the same React UI as the web studio and
does no AI work of its own. The design and the server API it uses are in [docs/DESKTOP.md](../docs/DESKTOP.md).

## Run, test, build

```bash
cd desktop
npm ci
npm run dev         # bundle main + preload (esbuild) and start Electron; builds ../frontend/dist once if it is missing
npm run typecheck   # tsc --noEmit
npm test            # unit tests (node --test, no Electron, GPU or FFmpeg needed)
npm run smoke       # start the app, load the UI through the gateway, sign in, call the API and /api/ws, print one JSON line
npm run dist        # Windows installer (NSIS, x64) in desktop/release
```

- `TATVAM_SERVER` sets the studio server on first run (default `http://localhost:8100`); `TATVAM_UI_DIR` points at a
  built UI (otherwise `resources/web` in the installed app, or `../frontend/dist` in dev).
- `npm run smoke` uses a throw-away userData folder. On an empty server it creates the first admin through the
  gateway; on a server that is already set up it signs in with `TATVAM_SMOKE_EMAIL` / `TATVAM_SMOKE_PASSWORD`, or
  checks only the anonymous paths. Exit code 0 means every check passed.
- `TATVAM_E2E=1 node --test test/e2e.test.ts` syncs, renders (4K HEVC by default) and uploads a real cut from a
  running server; see the file header for its variables.
- `npm run dist` copies the UI and an FFmpeg build into `build/` first (`TATVAM_FFMPEG` picks the binary; by default
  the backend's FFmpeg 7.1, which has NVENC, vidstab and every transition the server uses). Signing: set `CSC_LINK`
  (the .pfx file or its base64) and `CSC_KEY_PASSWORD`; without them the installer is unsigned. Releases publish to
  GitHub (`tatvama/veo_studio`) and the installed app updates itself from there.

## How it fits together

- **Gateway** (`src/main/gateway.ts`): an HTTP server on `127.0.0.1:18100` (the next free port if that one is taken,
  then remembered so the page origin and its localStorage stay the same). It serves the UI, forwards `/api`, `/media`,
  `/mcp` and the `/api/ws` WebSocket to the server, and serves `/media/<key>` from the project folder when the file is
  there (a 1080p proxy in proxy mode). Native features never go over HTTP: the UI calls `window.tatvamDesktop`.
- **Sign-in**: the session cookie lives on the gateway origin. The gateway strips `Domain` and `Secure` from the
  server's `Set-Cookie` and passes the cookie on. Google sign-in opens the server's `/api/auth/google/start` in its own
  window and copies the `veo_session` cookie onto the gateway origin when Google sends it back.
- **Offline**: when the server can't be reached, cached GET responses answer (header `X-Tatvam-Offline: 1`), cut edits
  (layers, trims, effects, overlays, reorder, episode settings) are queued and shown at once, and the queue replays in
  order when the server is back (checked every 5 s).
- **Bridge** (`src/preload/index.ts`, types in `src/shared/types.ts`, mirrored by `frontend/src/lib/desktop.ts`):
  library, naming, sync, imports, media, render, EDL, windows, app and offline calls over IPC. Only pages on the
  gateway origin may call it.

## Settings

`settings.json` in the app's userData folder (`%APPDATA%\Tatvam Studio`): `serverUrl`, `gatewayPort`, `uiSource`
(`bundled` or `server`), `libraryRoot` (default `Documents\Tatvam Projects`), `projectFolders` (moved projects),
`naming` (file name templates, §3.1), `pullScope` (`approved` or `cut`), `proxyMode`, `encoder`
(`prefer`: auto / nvenc / qsv / amf / software, `hevc10bit`, `intermediateCq`), `ffmpegPath`, `workspaces`,
`windowState`, `autoSync` and `watching`. Logs are in `userData/logs/main.log` (5 MB × 3), render jobs in
`renders.json`, the encoder test results in `hw-probe.json`.
