import assert from "node:assert/strict";
import { test } from "node:test";
import { columnsFor, itemsToLines, loopText, moveItem, NO_COLUMNS, parseLines, parseNumberLoose } from "../newsroom/tickers/lines.ts";

test("numbers as people type them: ₹, Indian commas, signs, units", () => {
  assert.equal(parseNumberLoose("₹73,450"), 73450);
  assert.equal(parseNumberLoose("1,23,456.7"), 123456.7);
  assert.equal(parseNumberLoose("+412.30"), 412.3);
  assert.equal(parseNumberLoose("−0.06"), -0.06);
  assert.equal(parseNumberLoose("0.51%"), 0.51);
  assert.equal(parseNumberLoose("34°C"), 34);
  assert.equal(parseNumberLoose("Delhi"), undefined);
  assert.equal(parseNumberLoose(""), undefined);
  assert.equal(parseNumberLoose("12.5.1"), undefined);
});

test("pasted lines: one item each, ! for priority, columns from a spreadsheet or |", () => {
  assert.deepEqual(parseLines("First line\n\n  !Second, flashing  \n", NO_COLUMNS), [{ text: "First line" }, { text: "Second, flashing", flash: true }]);
  const tags = { ...NO_COLUMNS, tag: true };
  assert.deepEqual(parseLines("Sports | India beat Malaysia 4–1\nNo tag here", tags), [{ tag: "Sports", text: "India beat Malaysia 4–1" }, { text: "No tag here" }]);
  const markets = { ...NO_COLUMNS, value: true, delta: true };
  assert.deepEqual(parseLines("SENSEX\t81,523.16\t+412.30\nNIFTY 50 | 24,926.70 | -118.45", markets),
    [{ text: "SENSEX", value: 81523.16, delta: 412.3 }, { text: "NIFTY 50", value: 24926.7, delta: -118.45 }]);
  const rates = { ...NO_COLUMNS, tag: true, value: true };
  assert.deepEqual(parseLines("Delhi\tPetrol\t₹94.72\nGold 22K | 73450", rates), [{ tag: "Delhi", text: "Petrol", value: 94.72 }, { text: "Gold 22K", value: 73450 }]);
  // a " | " inside a headline stays in the text when it isn't a column
  assert.deepEqual(parseLines("Budget 2026 | What changes for you | Explained", NO_COLUMNS), [{ text: "Budget 2026 | What changes for you | Explained" }]);
  // Hindi passes through unchanged
  assert.deepEqual(parseLines("दिल्ली में बारिश", NO_COLUMNS), [{ text: "दिल्ली में बारिश" }]);
});

test("items to lines and back keep everything", () => {
  const cols = { ...NO_COLUMNS, tag: true, value: true, delta: true };
  const items = [{ tag: "Delhi", text: "Gold 22K", value: 73450, delta: 250 }, { text: "Breaking line", flash: true }, { tag: "Mumbai", text: "Diesel", value: 89.97, delta: -0.12 }];
  assert.deepEqual(parseLines(itemsToLines(items, cols), cols), items);
});

test("columns shown are the details the list (or its sample) uses", () => {
  assert.deepEqual(columnsFor([{ text: "a" }]), NO_COLUMNS);
  assert.deepEqual(columnsFor([{ text: "a", tag: "x" }], [{ text: "b", value: 2, color: "#fff" }]), { tag: true, value: true, delta: false, icon: false, color: true });
  assert.deepEqual(columnsFor(undefined, [{ text: "Delhi", icon: "sun", value: 34 }]), { tag: false, value: true, delta: false, icon: true, color: false });
});

test("moving items, and the loop length in words", () => {
  assert.deepEqual(moveItem(["a", "b", "c", "d"], 0, 2), ["b", "c", "a", "d"]);
  assert.deepEqual(moveItem(["a", "b", "c", "d"], 3, 0), ["d", "a", "b", "c"]);
  assert.deepEqual(moveItem(["a", "b"], 1, 1), ["a", "b"]);
  assert.deepEqual(moveItem(["a", "b"], 5, 0), ["a", "b"]);
  assert.equal(loopText([]), "");
  assert.match(loopText([{ text: "IMD issues orange alert for Mumbai" }]), /^about \d+ s$/);
  const many = Array.from({ length: 12 }, () => ({ text: "Railways to run 30 festive special trains on the Delhi–Patna route" }));
  assert.match(loopText(many), /^about \d+ min( \d+ s)?$/);
});
