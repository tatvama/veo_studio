/**
 * Google sign-in for the desktop (docs/DESKTOP.md §1): the server's /api/auth/google/start opens in its own window;
 * once Google sends it back to the server (any non-/api page there), the `veo_session` cookie the server set is copied
 * onto the gateway origin, the window closes and the main window reloads.
 */
import { BrowserWindow, session } from "electron";
import { COOKIE } from "./upstream.ts";

let open: BrowserWindow | null = null;

export function googleSignIn(parent: BrowserWindow, serverUrl: string, gatewayUrl: string, log: (m: string) => void): Promise<boolean> {
  if (open && !open.isDestroyed()) {
    open.focus();
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      parent, width: 520, height: 720, title: "Sign in with Google", autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    open = win;
    const origins = new Set<string>([new URL(serverUrl).origin]);
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      open = null;
      if (!win.isDestroyed()) win.close();
      if (ok && !parent.isDestroyed()) {
        void parent.loadURL(`${gatewayUrl}/`);
      }
      resolve(ok);
    };
    const check = async (url: string) => {
      let u: URL;
      try { u = new URL(url); } catch { return; }
      if (u.pathname.startsWith("/api/auth/google/callback")) origins.add(u.origin); // the server's public address may differ
      if (!origins.has(u.origin) || u.pathname.startsWith("/api/")) return;
      for (const origin of origins) {
        const [c] = await session.defaultSession.cookies.get({ url: origin, name: COOKIE });
        if (!c) continue;
        await session.defaultSession.cookies.set({
          url: gatewayUrl, name: COOKIE, value: c.value, path: "/", httpOnly: true, secure: false, sameSite: "lax",
          ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}),
        });
        log("Google sign-in: session copied to the gateway");
        finish(true);
        return;
      }
    };
    win.webContents.on("did-navigate", (_e, url) => void check(url));
    win.webContents.on("did-redirect-navigation", (_e, url) => void check(url));
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.on("closed", () => finish(false));
    void win.loadURL(`${serverUrl}/api/auth/google/start`);
  });
}
