/**
 * The waitlist form's email and mobile-number checks (lib/contact.ts). They mirror backend/app/api/waitlist.py, which has
 * the last word: these tables are the same as the ones in backend/tests/test_waitlist.py, so the two can't drift apart.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asciiDigits, formatPhone, maskEmail, maskPhone, normalizePhone, validEmail } from "../contact.ts";

test("Indian numbers, however they are typed, become E.164", () => {
  for (const typed of [
    "9876543210", "98765 43210", "98765-43210", "+91 98765 43210", "+919876543210", "919876543210", "09876543210",
    "0091 98765 43210", "(+91) 98765.43210", "९८७६५४३२१०", "௯௮௭௬௫௪௩௨௧௦", // Hindi and Tamil digits
  ]) assert.equal(normalizePhone(typed), "+919876543210", typed);
});

test("bad numbers are refused", () => {
  for (const typed of [
    "", "   ", "abc", "12345", "5876543210", "98765432", "98765432100", "+91 5876543210", "+91 98765", "+0123456789",
    "+1234", "98765 43210 ext 4", "९८७६",
  ]) assert.equal(normalizePhone(typed), null, JSON.stringify(typed));
});

test("other countries only need a plausible length", () => {
  assert.equal(normalizePhone("+1 (415) 555-0123"), "+14155550123");
  assert.equal(normalizePhone("+44 7911 123456"), "+447911123456");
  assert.equal(normalizePhone("+1 415"), null);
});

test("emails: plain ASCII, and never a leading = + - @ (a spreadsheet would run it as a formula)", () => {
  const cases: [string, boolean][] = [
    ["asha@example.com", true], ["asha.rao+films@mail.example.co.in", true], ["a@b.io", true],
    ["", false], ["asha", false], ["asha@", false], ["@example.com", false], ["asha@example", false],
    ["asha@@example.com", false], ["a..b@example.com", false], ["asha rao@example.com", false],
    ["=cmd|' /C calc'!A0@example.com", false], ["+asha@example.com", false], ["-asha@example.com", false],
    ["आशा@example.com", false], [`${"a".repeat(65)}@example.com`, false], [`a@${"b".repeat(250)}.com`, false],
  ];
  for (const [email, ok] of cases) assert.equal(validEmail(email), ok, email);
});

test("native digits become 0-9 and everything else is left alone", () => {
  assert.equal(asciiDigits("+९१ ९८७६५ ४३२१०"), "+91 98765 43210");
  assert.equal(asciiDigits("௧௨௩ abc ౪౫౬ ೭೮೯ ０１"), "123 abc 456 789 01");
  assert.equal(asciiDigits("98765"), "98765");
});

test("display forms: national format for India, masked for the confirmation", () => {
  assert.equal(formatPhone("+919876543210"), "98765 43210");
  assert.equal(formatPhone("+447911123456"), "+447911123456");
  assert.equal(maskEmail("asha.rao@example.com"), "a••••••@example.com");
  assert.equal(maskEmail("ab@x.io"), "a••@x.io");
  assert.equal(maskPhone("+919876543210"), "+91 ••••• 210");
  assert.equal(maskPhone("+447911123456"), "••••• 456");
});
