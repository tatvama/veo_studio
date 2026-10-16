import { isDesktop } from "./desktop";

/**
 * The installed apps (Tatvam Desktop, the PWA added to a home screen or desktop) open straight to sign-in: the public
 * landing page is for people arriving on the web, not for someone who already has the app.
 */
export function isInstalledApp(): boolean {
  if (isDesktop) return true;
  try {
    return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}
