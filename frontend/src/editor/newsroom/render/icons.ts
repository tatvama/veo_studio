/**
 * The built-in vector icons of the News Room (docs/EDITOR.md §16.3), drawn by code on a 24 × 24 grid (our own
 * shapes, no icon font): arrows, play, the live dot, phone, video call, location pin, clock, calendar, quote marks,
 * check, cross, warning, info, the weather set, cricket, trophy, charts, the rupee sign and a few more. Each icon is
 * one or more parts, filled or stroked; `alt` parts take the icon layer's second colour (a sun in a rain cloud).
 * Kinds can add icons with `registerIcons`. Path2D objects are made on first draw (no DOM at import).
 */

export interface IconPart {
  /** SVG path data on a 24 × 24 grid. */
  d: string;
  /** fill (default) or stroke (line width `w`, round caps and joins). */
  mode?: "fill" | "stroke"; w?: number;
  /** Even-odd fill (holes). */
  evenodd?: boolean;
  /** Draw in the second colour. */
  alt?: boolean;
}
export interface IconDef { label: string; parts: IconPart[]; group?: string }

const circle = (cx: number, cy: number, r: number) => `M${cx - r} ${cy} A${r} ${r} 0 1 0 ${cx + r} ${cy} A${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
function star(cx: number, cy: number, ro: number, ri: number, n = 5): string {
  let d = "";
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? ri : ro, a = -Math.PI / 2 + (i * Math.PI) / n;
    d += `${i ? "L" : "M"}${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)} `;
  }
  return d + "Z";
}
const CLOUD = "M7 19 C4.2 19 2 16.9 2 14.3 C2 11.9 3.8 10 6.1 9.7 C6.9 6.9 9.4 5 12.3 5 C15.8 5 18.6 7.6 18.9 11 C21 11.3 22.5 13 22.5 15.1 C22.5 17.3 20.7 19 18.5 19 Z";
const CLOUD_HI = "M7 14.5 C4.5 14.5 2.5 12.6 2.5 10.3 C2.5 8.2 4.1 6.5 6.1 6.2 C6.9 3.8 9.1 2.2 11.6 2.2 C14.7 2.2 17.2 4.5 17.5 7.5 C19.4 7.7 20.8 9.2 20.8 11.1 C20.8 13 19.2 14.5 17.3 14.5 Z";
const S = (d: string, w = 2, alt = false): IconPart => ({ d, mode: "stroke", w, ...(alt ? { alt } : {}) });
const F = (d: string, o: Partial<IconPart> = {}): IconPart => ({ d, ...o });

const ICONS = new Map<string, IconDef>(Object.entries({
  arrow_up: { label: "Arrow up", group: "Arrows", parts: [F("M12 2.5 L21 12.5 H15.5 V21.5 H8.5 V12.5 H3 Z")] },
  arrow_down: { label: "Arrow down", group: "Arrows", parts: [F("M12 21.5 L3 11.5 H8.5 V2.5 H15.5 V11.5 H21 Z")] },
  arrow_right: { label: "Arrow right", group: "Arrows", parts: [F("M21.5 12 L11.5 3 V8.5 H2.5 V15.5 H11.5 V21 Z")] },
  arrow_left: { label: "Arrow left", group: "Arrows", parts: [F("M2.5 12 L12.5 3 V8.5 H21.5 V15.5 H12.5 V21 Z")] },
  tri_up: { label: "Up (markets)", group: "Arrows", parts: [F("M12 5 L21 18.5 H3 Z")] },
  tri_down: { label: "Down (markets)", group: "Arrows", parts: [F("M12 19 L3 5.5 H21 Z")] },
  chevron_right: { label: "Chevron", group: "Arrows", parts: [S("M9 4.5 L16.5 12 L9 19.5", 3)] },
  play: { label: "Play", group: "Media", parts: [F("M7 4 C7 3.2 7.9 2.7 8.6 3.1 L20.2 11.1 C20.8 11.5 20.8 12.5 20.2 12.9 L8.6 20.9 C7.9 21.3 7 20.8 7 20 Z")] },
  live: { label: "Live dot", group: "Media", parts: [F(circle(12, 12, 7))] },
  live_ring: { label: "Live dot with ring", group: "Media", parts: [F(circle(12, 12, 5)), S(circle(12, 12, 9.5), 1.6)] },
  mic: { label: "Microphone", group: "Media", parts: [F("M9 5.5 A3 3 0 0 1 15 5.5 V11 A3 3 0 0 1 9 11 Z"), S("M5.8 10.5 C5.8 14 8.6 16.8 12 16.8 C15.4 16.8 18.2 14 18.2 10.5 M12 16.8 V21 M8.5 21 H15.5", 1.8)] },
  camera: { label: "Camera", group: "Media", parts: [F(`M3 8 C3 7 3.8 6.2 4.8 6.2 H7.8 L9.3 4 H14.7 L16.2 6.2 H19.2 C20.2 6.2 21 7 21 8 V18 C21 19 20.2 19.8 19.2 19.8 H4.8 C3.8 19.8 3 19 3 18 Z ${circle(12, 12.8, 3.6)}`, { evenodd: true })] },
  phone: { label: "Phone", group: "People", parts: [F("M6.5 3 C5 3 3.5 4.5 3.5 6.5 C3.5 14 10 20.5 17.5 20.5 C19.5 20.5 21 19 21 17.5 L21 15.5 C21 15 20.6 14.6 20.1 14.5 L16.6 13.8 C16.2 13.7 15.8 13.9 15.6 14.2 L14.6 15.8 C11.8 14.5 9.5 12.2 8.2 9.4 L9.8 8.4 C10.1 8.2 10.3 7.8 10.2 7.4 L9.5 3.9 C9.4 3.4 9 3 8.5 3 Z")] },
  video_call: { label: "Video call", group: "People", parts: [F("M2.5 7.2 C2.5 6 3.5 5 4.7 5 H13.8 C15 5 16 6 16 7.2 V16.8 C16 18 15 19 13.8 19 H4.7 C3.5 19 2.5 18 2.5 16.8 Z M17.2 10 L21.5 7 V17 L17.2 14 Z")] },
  user: { label: "Person", group: "People", parts: [F(`${circle(12, 7.8, 4.3)} M3.5 21 C3.5 16.4 7.3 13.8 12 13.8 C16.7 13.8 20.5 16.4 20.5 21 Z`)] },
  pin: { label: "Location", group: "Places", parts: [F(`M12 2 C8.1 2 5 5.1 5 9 C5 14.2 12 22 12 22 C12 22 19 14.2 19 9 C19 5.1 15.9 2 12 2 Z ${circle(12, 9, 2.8)}`, { evenodd: true })] },
  globe: { label: "Globe", group: "Places", parts: [S(`${circle(12, 12, 9)} M3 12 H21 M12 3 C9.5 5.5 8.5 8.8 8.5 12 C8.5 15.2 9.5 18.5 12 21 C14.5 18.5 15.5 15.2 15.5 12 C15.5 8.8 14.5 5.5 12 3`, 1.7)] },
  flag: { label: "Flag", group: "Places", parts: [S("M5.5 21.5 V3", 2), F("M6.5 3.5 H19 L16.5 7.8 L19 12 H6.5 Z")] },
  clock: { label: "Clock", group: "Time", parts: [S(`${circle(12, 12, 9)} M12 6.8 V12 L15.6 14.2`, 2)] },
  calendar: { label: "Calendar", group: "Time", parts: [S("M4 6.5 C4 5.7 4.7 5 5.5 5 H18.5 C19.3 5 20 5.7 20 6.5 V19 C20 19.8 19.3 20.5 18.5 20.5 H5.5 C4.7 20.5 4 19.8 4 19 Z M4 10 H20 M8.2 3 V7 M15.8 3 V7", 1.9), F("M7 13 H10 V16 H7 Z")] },
  quote_open: { label: "Quote open", group: "Text", parts: [F("M10.5 5.5 C6.7 6.6 4 9.6 4 13.8 V18.5 H10.5 V12 H7.3 C7.6 10 9 8.6 11.2 7.9 Z M20.5 5.5 C16.7 6.6 14 9.6 14 13.8 V18.5 H20.5 V12 H17.3 C17.6 10 19 8.6 21.2 7.9 Z")] },
  quote_close: { label: "Quote close", group: "Text", parts: [F("M13.5 18.5 C17.3 17.4 20 14.4 20 10.2 V5.5 H13.5 V12 H16.7 C16.4 14 15 15.4 12.8 16.1 Z M3.5 18.5 C7.3 17.4 10 14.4 10 10.2 V5.5 H3.5 V12 H6.7 C6.4 14 5 15.4 2.8 16.1 Z")] },
  hashtag: { label: "Hashtag", group: "Text", parts: [S("M9.8 3.5 L7.8 20.5 M16.2 3.5 L14.2 20.5 M4.5 8.6 H20.3 M3.7 15.4 H19.5", 2)] },
  check: { label: "Check", group: "Marks", parts: [S("M4.5 12.5 L9.6 17.6 L19.5 6.5", 2.8)] },
  cross: { label: "Cross", group: "Marks", parts: [S("M6 6 L18 18 M18 6 L6 18", 2.8)] },
  check_circle: { label: "Check in a circle", group: "Marks", parts: [F(circle(12, 12, 10)), S("M7 12.3 L10.5 15.8 L17.2 8.6", 2.4, true)] },
  cross_circle: { label: "Cross in a circle", group: "Marks", parts: [F(circle(12, 12, 10)), S("M8.2 8.2 L15.8 15.8 M15.8 8.2 L8.2 15.8", 2.4, true)] },
  warning: { label: "Warning", group: "Marks", parts: [F("M12 2.5 C12.6 2.5 13.1 2.8 13.4 3.3 L22.2 18.8 C22.8 19.9 22 21.2 20.8 21.2 H3.2 C2 21.2 1.2 19.9 1.8 18.8 L10.6 3.3 C10.9 2.8 11.4 2.5 12 2.5 Z M10.9 8.5 H13.1 L12.8 14.6 H11.2 Z M10.9 16.3 H13.1 V18.5 H10.9 Z", { evenodd: true })] },
  info: { label: "Info", group: "Marks", parts: [F(`${circle(12, 12, 10)} M10.9 10.3 H13.1 V17.6 H10.9 Z M10.9 6.4 H13.1 V8.6 H10.9 Z`, { evenodd: true })] },
  bolt: { label: "Breaking (bolt)", group: "Marks", parts: [F("M13.8 1.8 L4.8 13.6 H11 L9.6 22.2 L19.2 9.6 H13.1 Z")] },
  star: { label: "Star", group: "Marks", parts: [F(star(12, 12.6, 10, 4.2))] },
  sun: { label: "Sunny", group: "Weather", parts: [F(circle(12, 12, 4.4)), S("M12 2.2 V4.6 M12 19.4 V21.8 M2.2 12 H4.6 M19.4 12 H21.8 M5.1 5.1 L6.8 6.8 M17.2 17.2 L18.9 18.9 M5.1 18.9 L6.8 17.2 M17.2 6.8 L18.9 5.1", 2)] },
  cloud: { label: "Cloudy", group: "Weather", parts: [F(CLOUD)] },
  cloud_sun: { label: "Partly cloudy", group: "Weather", parts: [F(circle(8.6, 8.4, 3.6), { alt: true }), S("M8.6 1.8 V3.2 M2 8.4 H3.4 M3.9 3.7 L4.9 4.7 M13.3 3.7 L12.3 4.7", 1.8, true), F("M8.2 21 C5.8 21 3.9 19.2 3.9 17 C3.9 14.9 5.4 13.3 7.4 13 C8.1 10.6 10.2 9 12.7 9 C15.7 9 18.1 11.2 18.4 14.1 C20.2 14.3 21.6 15.8 21.6 17.6 C21.6 19.5 20 21 18.1 21 Z")] },
  rain: { label: "Rain", group: "Weather", parts: [F(CLOUD_HI), S("M8 17 L6.8 21 M12.2 17 L11 21 M16.4 17 L15.2 21", 2, true)] },
  storm: { label: "Thunderstorm", group: "Weather", parts: [F(CLOUD_HI), F("M12.6 13 L8.8 18.6 H11.9 L10.6 23 L15.8 16.4 H12.7 L14.2 13 Z", { alt: true })] },
  fog: { label: "Fog", group: "Weather", parts: [F("M7 11.5 C4.8 11.5 3.2 10 3.2 8.1 C3.2 6.4 4.5 5 6.1 4.8 C6.8 2.9 8.7 1.6 10.9 1.6 C13.6 1.6 15.8 3.6 16 6.2 C17.6 6.4 18.8 7.6 18.8 9.1 C18.8 10.4 17.6 11.5 16.1 11.5 Z"), S("M3 15 H21 M5 18.5 H19 M7.5 22 H16.5", 1.9, true)] },
  snow: { label: "Snow", group: "Weather", parts: [F(CLOUD_HI), F(`${circle(8, 18.2, 1.3)} ${circle(12.2, 20.6, 1.3)} ${circle(16.4, 18.2, 1.3)} ${circle(10.1, 23, 1)} ${circle(14.3, 23, 1)}`, { alt: true })] },
  wind: { label: "Wind", group: "Weather", parts: [S("M3 8.5 H14 C15.9 8.5 17 7.3 17 5.8 C17 4.4 15.9 3.3 14.5 3.3 C13.4 3.3 12.5 4 12.2 4.9 M3 12.5 H19 C20.7 12.5 22 13.8 22 15.5 C22 17.2 20.7 18.5 19 18.5 C17.8 18.5 16.8 17.8 16.4 16.8 M3 16.5 H11", 2)] },
  thermometer: { label: "Temperature", group: "Weather", parts: [S("M10 14.2 V5 A2 2 0 0 1 14 5 V14.2 A4 4 0 1 1 10 14.2 Z", 1.8), F(circle(12, 17.4, 2.2), { alt: true }), S("M12 9 V16", 1.8, true)] },
  humidity: { label: "Humidity", group: "Weather", parts: [F("M12 2.5 C12 2.5 5 10.4 5 15 C5 18.9 8.1 21.8 12 21.8 C15.9 21.8 19 18.9 19 15 C19 10.4 12 2.5 12 2.5 Z")] },
  cricket_bat: { label: "Cricket bat", group: "Sport", parts: [F("M14.2 3.6 L20.4 9.8 L10.6 19.6 C9.8 20.4 8.6 20.4 7.8 19.6 L4.4 16.2 C3.6 15.4 3.6 14.2 4.4 13.4 Z"), S("M18.6 5.4 L22 2", 2.4), F(circle(5.4, 5.4, 2.6), { alt: true })] },
  cricket_ball: { label: "Cricket ball", group: "Sport", parts: [F(circle(12, 12, 9)), S("M9.4 3.6 C11.4 8.8 11.4 15.2 9.4 20.4 M14.6 3.6 C12.6 8.8 12.6 15.2 14.6 20.4", 1.1, true)] },
  football: { label: "Football", group: "Sport", parts: [F(`${circle(12, 12, 9.5)} M12 7.6 L15.6 10.2 L14.2 14.4 H9.8 L8.4 10.2 Z`, { evenodd: true })] },
  trophy: { label: "Trophy", group: "Sport", parts: [F("M7 3 H17 V9 C17 11.8 14.8 14 12 14 C9.2 14 7 11.8 7 9 Z M10.8 14 H13.2 V17.6 H10.8 Z M7.5 18 H16.5 V21 H7.5 Z"), S("M7 5 H4 V7 C4 9 5.5 10.5 7.3 10.6 M17 5 H20 V7 C20 9 18.5 10.5 16.7 10.6", 1.8)] },
  chart: { label: "Bar chart", group: "Data", parts: [F("M3.5 20.5 V13 H8 V20.5 Z M9.8 20.5 V8 H14.2 V20.5 Z M16 20.5 V3.5 H20.5 V20.5 Z")] },
  trend_up: { label: "Trend up", group: "Data", parts: [S("M3 17.5 L9 11.5 L13 15.5 L21 7.5 M15 7.5 H21 V13.5", 2.2)] },
  trend_down: { label: "Trend down", group: "Data", parts: [S("M3 6.5 L9 12.5 L13 8.5 L21 16.5 M15 16.5 H21 V10.5", 2.2)] },
  pie: { label: "Pie chart", group: "Data", parts: [F("M11 3.1 V13 H20.9 C20.4 18 16.2 21.9 11 21.9 C5.5 21.9 1.1 17.5 1.1 12 C1.1 6.8 5 2.6 11 3.1 Z"), F("M13 1.1 C18.3 1.6 22.4 5.7 22.9 11 H13 Z", { alt: true })] },
  rupee: { label: "Rupee", group: "Data", parts: [S("M6 3.5 H18 M6 8 H18 M9 3.5 C12.6 3.5 14.6 5.4 14.6 8 C14.6 10.6 12.6 12.6 9 12.6 H6.8 L15.2 21", 2.1)] },
  ballot: { label: "Vote", group: "Data", parts: [F("M3 13 H21 V21 H3 Z"), F("M7 4 H15.5 L17.5 6 V13 H7 Z", { alt: true }), S("M9.3 8.8 L11.2 10.7 L14.8 7.1", 1.7)] },
  home: { label: "Home", group: "Places", parts: [F("M12 3 L21.5 11 H18.8 V21 H14.4 V15 H9.6 V21 H5.2 V11 H2.5 Z")] },
  eye: { label: "Eye (views)", group: "Text", parts: [F(`M12 5 C6.8 5 3 9.2 1.5 12 C3 14.8 6.8 19 12 19 C17.2 19 21 14.8 22.5 12 C21 9.2 17.2 5 12 5 Z ${circle(12, 12, 3.4)}`, { evenodd: true })] },
  heart: { label: "Heart", group: "Text", parts: [F("M12 21 C12 21 2.5 15 2.5 8.6 C2.5 5.6 4.8 3.3 7.7 3.3 C9.5 3.3 11.1 4.2 12 5.6 C12.9 4.2 14.5 3.3 16.3 3.3 C19.2 3.3 21.5 5.6 21.5 8.6 C21.5 15 12 21 12 21 Z")] },
}));

/** Adds icons (other kinds' own); later ids replace earlier ones. */
export function registerIcons(defs: Record<string, IconDef>): void { for (const [k, v] of Object.entries(defs)) { ICONS.set(k, v); paths.delete(k); } }
export const iconDef = (name: string): IconDef | undefined => ICONS.get(name);
/** Every icon, for pickers: [id, def]. */
export const iconList = (): [string, IconDef][] => [...ICONS.entries()];

const paths = new Map<string, Path2D[]>();
function pathsOf(name: string, def: IconDef): Path2D[] | null {
  if (typeof Path2D === "undefined") return null;
  let p = paths.get(name);
  if (!p) { p = def.parts.map((x) => new Path2D(x.d)); paths.set(name, p); }
  return p;
}

type G = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
/**
 * Draws an icon centred in a box (contain) in `color` (alt parts in `color2`). `weight` scales stroke widths.
 * Returns false when the icon is unknown.
 */
export function drawIcon(g: G, name: string, x: number, y: number, w: number, h: number, color: string | CanvasGradient, color2?: string | CanvasGradient, weight = 1): boolean {
  const def = ICONS.get(name);
  if (!def) return false;
  const ps = pathsOf(name, def);
  if (!ps) return false;
  const s = Math.min(w, h) / 24;
  g.save();
  g.translate(x + (w - 24 * s) / 2, y + (h - 24 * s) / 2);
  g.scale(s, s);
  g.lineCap = "round"; g.lineJoin = "round";
  def.parts.forEach((part, i) => {
    const c = part.alt ? color2 ?? color : color;
    if (part.mode === "stroke") { g.strokeStyle = c; g.lineWidth = (part.w ?? 2) * weight; g.stroke(ps[i]); }
    else { g.fillStyle = c; g.fill(ps[i], part.evenodd ? "evenodd" : "nonzero"); }
  });
  g.restore();
  return true;
}
