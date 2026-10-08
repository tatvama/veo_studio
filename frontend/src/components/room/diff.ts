/** Small line diff (longest common subsequence) for comparing script versions, plus a word-level pass for changed lines. */

export interface Seg { text: string; changed: boolean }
export interface DiffRow { op: "same" | "add" | "del"; text: string; a?: number; b?: number; segs?: Seg[] }
export type DiffItem = { kind: "row"; row: DiffRow } | { kind: "fold"; rows: DiffRow[] };

const MAX_CELLS = 4_000_000;

/** Rows describing how to get from `a` (old) to `b` (new). Line numbers are 1-based. */
export function diffLines(a: string[], b: string[]): DiffRow[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let ea = a.length;
  let eb = b.length;
  while (ea > pre && eb > pre && a[ea - 1] === b[eb - 1]) { ea--; eb--; }

  const rows: DiffRow[] = [];
  for (let i = 0; i < pre; i++) rows.push({ op: "same", text: a[i], a: i + 1, b: i + 1 });

  const A = a.slice(pre, ea);
  const B = b.slice(pre, eb);
  const n = A.length;
  const m = B.length;
  if (n * m > MAX_CELLS) {
    A.forEach((text, i) => rows.push({ op: "del", text, a: pre + i + 1 }));
    B.forEach((text, j) => rows.push({ op: "add", text, b: pre + j + 1 }));
  } else {
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w); // dp[i][j] = LCS length of A[i..] and B[j..]
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) {
        rows.push({ op: "same", text: A[i], a: pre + i + 1, b: pre + j + 1 });
        i++; j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
        rows.push({ op: "del", text: A[i], a: pre + i + 1 });
        i++;
      } else {
        rows.push({ op: "add", text: B[j], b: pre + j + 1 });
        j++;
      }
    }
    for (; i < n; i++) rows.push({ op: "del", text: A[i], a: pre + i + 1 });
    for (; j < m; j++) rows.push({ op: "add", text: B[j], b: pre + j + 1 });
  }

  for (let k = 0; k < a.length - ea; k++) rows.push({ op: "same", text: a[ea + k], a: ea + k + 1, b: eb + k + 1 });
  return rows;
}

export function diffStats(rows: DiffRow[]) {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.op === "add") added++;
    else if (r.op === "del") removed++;
  }
  return { added, removed };
}

/** Collapse long runs of unchanged lines, keeping `context` lines around each change. */
export function foldUnchanged(rows: DiffRow[], context = 2): DiffItem[] {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.op === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true;
  });
  const out: DiffItem[] = [];
  let run: DiffRow[] = [];
  const flush = () => {
    if (!run.length) return;
    if (run.length <= 3) run.forEach((row) => out.push({ kind: "row", row }));
    else out.push({ kind: "fold", rows: run });
    run = [];
  };
  rows.forEach((r, i) => {
    if (keep[i]) {
      flush();
      out.push({ kind: "row", row: r });
    } else run.push(r);
  });
  flush();
  return out;
}

// ── word level ───────────────────────────────────────────────────────────────

const tokens = (s: string) => s.match(/\s+|[^\s]+/g) ?? [];

function merge(parts: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && last.changed === p.changed) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}

/** Which words of `a` and `b` differ (whitespace-aware LCS over tokens). Returns null when the lines are too unlike to be worth marking. */
export function wordDiff(a: string, b: string): { a: Seg[]; b: Seg[] } | null {
  const A = tokens(a);
  const B = tokens(b);
  const n = A.length;
  const m = B.length;
  if (!n || !m || n * m > 40_000) return null;
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const sa: Seg[] = [];
  const sb: Seg[] = [];
  let common = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { sa.push({ text: A[i], changed: false }); sb.push({ text: B[j], changed: false }); if (A[i].trim()) common++; i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { sa.push({ text: A[i], changed: true }); i++; }
    else { sb.push({ text: B[j], changed: true }); j++; }
  }
  for (; i < n; i++) sa.push({ text: A[i], changed: true });
  for (; j < m; j++) sb.push({ text: B[j], changed: true });
  const words = A.filter((x) => x.trim()).length + B.filter((x) => x.trim()).length;
  if (words && (2 * common) / words < 0.3) return null; // mostly different: highlighting every word would only add noise
  return { a: merge(sa), b: merge(sb) };
}

/** Pairs removed lines with the added lines that replace them and attaches word-level segments to both. */
export function markWords(rows: DiffRow[]): DiffRow[] {
  const out = rows.map((r) => ({ ...r }));
  let k = 0;
  while (k < out.length) {
    if (out[k].op === "same") { k++; continue; }
    const start = k;
    while (k < out.length && out[k].op !== "same") k++;
    const dels = out.slice(start, k).filter((r) => r.op === "del");
    const adds = out.slice(start, k).filter((r) => r.op === "add");
    for (let p = 0; p < Math.min(dels.length, adds.length); p++) {
      const wd = wordDiff(dels[p].text, adds[p].text);
      if (wd) { dels[p].segs = wd.a; adds[p].segs = wd.b; }
    }
  }
  return out;
}
