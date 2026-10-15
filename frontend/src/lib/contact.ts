/**
 * Email and mobile-number checks for the waitlist form. They mirror backend/app/api/waitlist.py (valid_email,
 * normalize_phone): the server has the last word, this only gives answers while people type.
 */

/** Zero of each Indian script's digits (Devanagari … Malayalam), Arabic-Indic and full-width. */
const ZEROS = [0x660, 0x6f0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xff10];

/** Native digits (९८७६…, ௯௮௭…) become 0-9, so a phone keyboard set to Hindi, Tamil, Telugu or Kannada just works. */
export function asciiDigits(s: string): string {
  return s.replace(/\p{Nd}/gu, (c) => {
    const cp = c.codePointAt(0)!;
    const zero = ZEROS.find((z) => cp >= z && cp <= z + 9);
    return zero === undefined ? c : String(cp - zero);
  });
}

const EMAIL_RE = /^[A-Za-z0-9][A-Za-z0-9._%+-]*@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/;

export function validEmail(email: string): boolean {
  return email.length <= 254 && email.split("@")[0].length <= 64 && !email.includes("..") && EMAIL_RE.test(email);
}

/** E.164 from whatever was typed, or null. No country code means India: a 10-digit mobile starting 6-9. */
export function normalizePhone(raw: string): string | null {
  let s = asciiDigits(raw).replace(/[\s\-.()]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (s.startsWith("+")) {
    const digits = s.slice(1);
    if (!/^[1-9][0-9]{7,14}$/.test(digits)) return null;
    if (digits.startsWith("91") && !/^91[6-9][0-9]{9}$/.test(digits)) return null;
    return "+" + digits;
  }
  if (!/^[0-9]+$/.test(s)) return null;
  if (s.length === 12 && s.startsWith("91")) s = s.slice(2);
  else if (s.length === 11 && s.startsWith("0")) s = s.slice(1);
  return /^[6-9][0-9]{9}$/.test(s) ? "+91" + s : null;
}

/** +919876543210 → 98765 43210 (the +91 is shown beside the field). Other countries keep their code: +44 7911 123456. */
export function formatPhone(e164: string): string {
  return /^\+91[0-9]{10}$/.test(e164) ? `${e164.slice(3, 8)} ${e164.slice(8)}` : e164;
}

/** For the confirmation: enough to recognise your own details, not enough for someone looking over your shoulder. */
export function maskEmail(email: string): string {
  const [local, domain = ""] = email.split("@");
  return `${local.slice(0, 1)}${"•".repeat(Math.max(2, Math.min(local.length - 1, 6)))}@${domain}`;
}

/** +91 ••••• 210 for India; other countries show only the last digits (their country codes vary in length). */
export function maskPhone(e164: string): string {
  if (e164.length < 6) return e164;
  return `${e164.startsWith("+91") ? "+91 " : ""}${"•".repeat(5)} ${e164.slice(-3)}`;
}
