/**
 * Building blocks for the built-in screen layouts (templates/layouts.ts): the studio backdrop, video boxes with their
 * reveal, the topic header, panels, text and the shared motion. Every layout uses these so the set reads as one
 * channel: plates lead, text follows (60–120 ms staggers), boxes come in one after another and hold their place on
 * the way out (only labels and text leave). Pure data.
 */
import { anim, layer, rect, step, text } from "../templates/kit.ts";
import type { AnimStep, Box, GfxLayer, LayerAnim } from "../types.ts";

export const S16 = { w: 1920, h: 1080 } as const;
export const S9 = { w: 1080, h: 1920 } as const;

/** Text and plates leave like this (boxes hold; the backdrop cuts with the layout or stays for the next one). */
export const OUT: AnimStep = step("fade", { dur: 0.28 });
/** Boxes keep their place while the layout leaves; their name tags fade. */
export const HOLD: AnimStep = step("hold", { dur: 0.45 });

export const rise = (delay: number, dur = 0.45): LayerAnim => anim(step("rise", { dur, delay, distance: 26 }), OUT);
export const fadeIn = (delay: number, dur = 0.4): LayerAnim => anim(step("fade", { dur, delay }), OUT);
export const wipeIn = (delay: number, dir: "left" | "right" | "up" | "down" = "right", dur = 0.45): LayerAnim => anim(step("wipe", { dir, dur, delay }), OUT);

/** Reveals for boxes. Boxes over a full picture (OTS, PiP) must open from nothing (wipe, grow, unfold). */
export const POP = (delay = 0, dur = 0.5): AnimStep => step("pop", { dur, delay });
export const SLIDE = (dir: "left" | "right" | "up" | "down", delay = 0, dur = 0.55): AnimStep => step("slide", { dir, dur, delay, distance: 140 });
export const WIPE = (dir: "left" | "right" | "up" | "down", delay = 0, dur = 0.5): AnimStep => step("wipe", { dir, dur, delay });
export const UNFOLD = (delay = 0, dur = 0.55): AnimStep => step("unfold", { dur, delay });
export const ZOOM = (delay = 0, dur = 0.55): AnimStep => step("zoom", { dur, delay });

/** The studio plate behind a layout (no in / out of its own: it cuts in, or stays put while boxes glide). */
export function backdrop(space: { w: number; h: number }, p: Record<string, unknown> = {}): GfxLayer {
  return layer("backdrop", "bg", [0, 0, space.w, space.h], p, { name: "Backdrop" });
}

/** A video box. */
export function vbox(index: number, box: Box, p: Record<string, unknown> = {}, reveal: AnimStep = POP(index * 0.08), extra: Partial<GfxLayer> = {}): GfxLayer {
  return layer("slot", `box${index}`, box, { index, ...p }, { name: index === 0 ? "Main box" : `Box ${index + 1}`, anim: anim(reveal, HOLD), ...extra });
}
/** A soft drop shadow for boxes that float over a picture (inset, over-the-shoulder). */
export const FLOAT: Partial<GfxLayer> = { shadow: { color: "#000000b0", blur: 26, x: 0, y: 8 } };

/** Name tag props for a box: name and second line from fields. */
export const tagged = (name: string, sub?: string, o: Record<string, unknown> = {}) => ({ label: `{${name}}`, ...(sub ? { sub: `{${sub}}` } : {}), ...o });

/**
 * The topic header: a plate in the look's primary with an accent stripe that grows to the text, top-left. Hidden
 * when the field is empty.
 */
export function header(x: number, y: number, maxW: number, h = 60, field = "topic", size = 34, delay = 0.12): GfxLayer[] {
  return [
    rect("hdr_plate", [x, y, 320, h], { fill: "@primary", stripe: "left", stripeWidth: 8 }, { name: "Header plate", when: `{${field}}`, anim: wipeIn(delay) }),
    text("hdr", [x + 30, y, maxW - 30, h], `{${field}}`, { font: "@headline", size, weight: 700, color: "@textOnPrimary", upper: "look", fit: "shrink", maxLines: 1,
      grow: { layers: ["hdr_plate"], pad: 26, min: 220, max: maxW } }, { name: "Header", when: `{${field}}`, clip: "hdr_plate", anim: fadeIn(delay + 0.16, 0.3) }),
  ];
}

/** A kicker tag (accent plate with dark capitals) that grows to its text. */
export function kicker(id: string, x: number, y: number, maxW: number, h: number, field: string, size: number, delay: number, fill = "@accent", color = "@dark"): GfxLayer[] {
  return [
    rect(`${id}_plate`, [x, y, 160, h], { fill }, { name: `${id} plate`, when: `{${field}}`, anim: wipeIn(delay) }),
    text(id, [x + 18, y, maxW - 18, h], `{${field}}`, { font: "@headline", size, weight: 700, color, upper: "on", tracking: 1.5, fit: "shrink", maxLines: 1,
      grow: { layers: [`${id}_plate`], pad: 18, min: 90, max: maxW } }, { when: `{${field}}`, clip: `${id}_plate`, anim: fadeIn(delay + 0.12, 0.25) }),
  ];
}

/** A panel plate (glassy dark with a top accent line). */
export const panel = (id: string, box: Box, delay = 0.18, fill = "@dark/78") =>
  rect(id, box, { fill, shape: "flat", stripe: "top", stripeWidth: 6, stripeColor: "@accent", gloss: 0.08 }, { name: "Panel", anim: wipeIn(delay, "down", 0.5) });

/** Headline text (look headline font, bold). */
export const headline = (id: string, box: Box, value: string, size: number, delay: number, o: Record<string, unknown> = {}) =>
  text(id, box, value, { font: "@headline", size, weight: 700, color: "@text", lineHeight: 1.12, fit: "shrink", valign: "top", ...o }, { anim: rise(delay) });

/** Body text. */
export const body = (id: string, box: Box, value: string, size: number, delay: number, o: Record<string, unknown> = {}) =>
  text(id, box, value, { font: "@body", size, weight: 500, color: "@light/88", lineHeight: 1.25, fit: "shrink", valign: "top", ...o }, { anim: rise(delay) });

/** A bullet point row: an accent square and its text (hidden when the field is empty). */
export function point(i: number, x: number, y: number, w: number, h: number, size: number, delay: number, color = "@text", dot = "@accent"): GfxLayer[] {
  const f = `point${i}`;
  return [
    rect(`dot${i}`, [x, y + size * 0.42, size * 0.42, size * 0.42], { fill: dot, shape: "rounded", radius: 2 }, { name: `Bullet ${i}`, when: `{${f}}`, anim: anim(step("pop", { dur: 0.35, delay }), OUT) }),
    text(`pt${i}`, [x + size * 0.95, y, w - size * 0.95, h], `{${f}}`, { font: "@body", size, weight: 600, color, lineHeight: 1.2, maxLines: 2, fit: "shrink", valign: "top" },
      { name: `Point ${i}`, when: `{${f}}`, anim: rise(delay + 0.06) }),
  ];
}
