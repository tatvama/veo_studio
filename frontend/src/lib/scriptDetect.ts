/**
 * Is what someone typed into Home's box a script (use their words) or an idea (write one for them)? A quick read on the
 * client, so the box can say "Script found: 3 scenes, 12 lines" before anything is made. The server reads the script
 * properly on import (core/script_import.py); this only picks the path.
 *
 * Plain string checks, no regular expressions: the text is the user's and can be long.
 */

export interface ScriptGuess {
  script: boolean;
  /** Scene headings (SCENE …, INT. …, EXT. …), at least 1 for a script. */
  scenes: number;
  /** Dialogue and voice-over lines (NAME: words, VO: words). */
  lines: number;
}

const SLUGS = ["INT.", "EXT.", "INT ", "EXT ", "INT/EXT", "I/E ", "INT-", "EXT-"];
/** Long enough to be a written piece rather than an idea, once it also runs over several lines. */
const LONG = 600;
const VERY_LONG = 1500;

const isDigit = (c: number) => c >= 48 && c <= 57;

/** "SCENE 1: …", "Scene 2 – …", "INT. KITCHEN – NIGHT", "EXT GARDEN": a scene starts here. */
function isHeading(line: string): boolean {
  if (line.length > 140) return false;
  if (line.startsWith("SCENE")) return true;
  if (line.startsWith("Scene ") && isDigit(line.charCodeAt(6))) return true;
  return SLUGS.some((h) => line.startsWith(h));
}

const NAME_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ .'-";

/** "RAVI: words", "AJJI (proud): words", "VO: words". The name is in capitals, at most 40 characters before the colon. */
function isDialogue(line: string): boolean {
  const colon = line.indexOf(":");
  if (colon < 2 || colon > 40) return false;
  let name = line.slice(0, colon).trim();
  const paren = name.indexOf("(");  // the emotion in brackets: "AJJI (proud)"
  if (paren > 0) name = name.slice(0, paren).trim();
  if (name.length < 2 || !line.slice(colon + 1).trim()) return false;
  const first = name.charCodeAt(0);
  if (first < 65 || first > 90) return false; // starts with A–Z
  let letters = 0;
  for (const ch of name) {
    if (!NAME_CHARS.includes(ch)) return false; // lower case or digits: a sentence, not a speaker
    if (ch >= "A" && ch <= "Z") letters++;
  }
  // layout keywords are not speakers
  const word = name.split(" ")[0];
  if (["VISUAL", "SOUND", "MUSIC", "MOOD", "LOOK", "SFX", "CHARACTERS", "LIGHTING", "WEATHER", "SHOT", "TITLE", "NOTE"].includes(word)) return false;
  return letters >= 2;
}

export function detectScript(text: string): ScriptGuess {
  const rows = text.split("\n").map((l) => l.trim()).filter(Boolean);
  let scenes = 0;
  let lines = 0;
  for (const r of rows) {
    if (isHeading(r)) scenes++;
    else if (isDialogue(r)) lines++;
  }
  const size = text.trim().length;
  const script = (scenes >= 1 && rows.length >= 3)
    || (lines >= 2 && rows.length >= 3)
    || (size >= LONG && rows.length >= 5)
    || size >= VERY_LONG;
  return { script, scenes: script ? Math.max(scenes, 1) : scenes, lines };
}

/** A short name for a project made from a pasted script: its first line when that reads like a title. */
export function scriptTitle(text: string): string {
  const first = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  if (!first || first.length > 60 || isHeading(first) || isDialogue(first) || first.endsWith(":")) return "";
  return first.startsWith("TITLE:") ? first.slice(6).trim() : first;
}

/** The script without its title line (scriptTitle), so the title isn't read as a scene of its own. */
export function withoutTitle(text: string): string {
  if (!scriptTitle(text)) return text;
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.trim());
  return lines.slice(i + 1).join("\n").trim();
}
