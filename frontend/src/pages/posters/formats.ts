/** Size presets. Pixel sizes are what each platform expects; print sizes are at 300 dpi. */

export interface Format {
  key: string;
  label: string;
  group: "Print" | "Video" | "Social" | "Web" | "Custom";
  width: number;
  height: number;
  /** what it is for, shown under the label */
  hint: string;
  /** areas the platform covers with its own UI, as fractions of each side (drawn as guides) */
  safe?: { top?: number; right?: number; bottom?: number; left?: number };
}

export const FORMATS: Format[] = [
  { key: "film_poster", label: "Film poster", group: "Print", width: 2000, height: 3000, hint: "2:3 one-sheet, theatre and OTT key art" },
  { key: "a4_flyer", label: "A4 flyer", group: "Print", width: 2480, height: 3508, hint: "Print at 300 dpi" },
  { key: "a3_poster", label: "A3 poster", group: "Print", width: 3508, height: 4961, hint: "Print at 300 dpi" },
  { key: "billboard", label: "Hoarding 3:1", group: "Print", width: 4800, height: 1600, hint: "Wide outdoor banner" },
  { key: "yt_thumbnail", label: "YouTube thumbnail", group: "Video", width: 1280, height: 720, hint: "16:9, keep faces big",
    safe: { right: 0.16, bottom: 0.14 } },
  { key: "yt_banner", label: "YouTube banner", group: "Video", width: 2560, height: 1440, hint: "Channel art; centre stays visible",
    safe: { top: 0.35, bottom: 0.35, left: 0.24, right: 0.24 } },
  { key: "ott_landscape", label: "OTT tile 16:9", group: "Video", width: 1920, height: 1080, hint: "Streaming app thumbnail" },
  { key: "ig_post", label: "Instagram post", group: "Social", width: 1080, height: 1350, hint: "4:5 feed post" },
  { key: "square", label: "Square post", group: "Social", width: 1080, height: 1080, hint: "Instagram, Facebook, WhatsApp" },
  { key: "story", label: "Story / Reel cover", group: "Social", width: 1080, height: 1920, hint: "9:16, keep text in the middle",
    safe: { top: 0.13, bottom: 0.2 } },
  { key: "whatsapp_status", label: "WhatsApp status", group: "Social", width: 1080, height: 1920, hint: "9:16 status image",
    safe: { top: 0.1, bottom: 0.12 } },
  { key: "x_header", label: "X / Twitter header", group: "Web", width: 1500, height: 500, hint: "3:1 profile header",
    safe: { left: 0.18, bottom: 0.25 } },
  { key: "fb_cover", label: "Facebook cover", group: "Web", width: 1640, height: 624, hint: "Page cover photo" },
  { key: "landscape", label: "Landscape 16:9", group: "Web", width: 1920, height: 1080, hint: "Slides, banners, title cards" },
];

export const FORMAT_GROUPS: Format["group"][] = ["Print", "Video", "Social", "Web"];

export function formatOf(key: string | null | undefined): Format | undefined {
  return FORMATS.find((f) => f.key === key);
}

/** "2:3", "16:9"… for a size (reduced, or a decimal ratio when it doesn't reduce nicely). */
export function ratioLabel(w: number, h: number): string {
  const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
  const d = g(Math.round(w), Math.round(h)) || 1;
  const a = Math.round(w / d), b = Math.round(h / d);
  return a <= 32 && b <= 32 ? `${a}:${b}` : (w / h).toFixed(2);
}
