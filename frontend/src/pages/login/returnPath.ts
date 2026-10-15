// Google sign-in leaves the app and comes back to "/", so the page that showed this form (path + query, e.g. an MCP
// app's /oauth/consent?request=…) is kept for a few minutes in this tab and restored by App after sign-in.
// (Email sign-in never leaves the page, so it keeps the address by itself.)
const RETURN_KEY = "veo-return-to";
const RETURN_TTL_MS = 15 * 60_000;

export function rememberReturnPath() {
  const to = window.location.pathname + window.location.search;
  try {
    if (to === "/") sessionStorage.removeItem(RETURN_KEY);
    else sessionStorage.setItem(RETURN_KEY, JSON.stringify({ to, at: Date.now() }));
  } catch { /* storage blocked */ }
}

/** The same-origin path saved before Google sign-in (read once), or null. */
export function takeReturnPath(): string | null {
  try {
    const raw = sessionStorage.getItem(RETURN_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(RETURN_KEY);
    const { to, at } = JSON.parse(raw) as { to?: unknown; at?: unknown };
    const fresh = typeof at === "number" && Date.now() - at < RETURN_TTL_MS;
    return fresh && typeof to === "string" && to.startsWith("/") && !to.startsWith("//") ? to : null;
  } catch {
    return null;
  }
}
