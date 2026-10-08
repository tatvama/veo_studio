/**
 * Small fuzzy matcher for the command palette: subsequence match with bonuses for word starts and
 * consecutive runs. Returns the matched character indices so the UI can highlight them.
 */
export interface FuzzyMatch { score: number; indices: number[] }

const isBoundary = (s: string, i: number) => i === 0 || /[\s\-_/·›:'"(]/.test(s[i - 1]);

/** Can q[qi..] still be matched as a subsequence of t[ti..]? */
function fits(q: string, qi: number, t: string, ti: number): boolean {
  for (; qi < q.length; qi++) {
    const k = t.indexOf(q[qi], ti);
    if (k < 0) return false;
    ti = k + 1;
  }
  return true;
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();

  // Exact substring gets the best score and a contiguous highlight.
  const at = t.indexOf(q);
  if (at >= 0) {
    const indices = Array.from({ length: q.length }, (_, k) => at + k);
    return { score: 1000 - at * 2 + (isBoundary(t, at) ? 200 : 0) - (t.length - q.length) * 0.5, indices };
  }

  const qq = q.replace(/ /g, "");
  if (!fits(qq, 0, t, 0)) return null;

  // Subsequence match: take the next char right after the previous one, else a word-start occurrence,
  // else the leftmost — but only if the rest of the query still fits afterwards.
  const indices: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (let qi = 0; qi < qq.length; qi++) {
    const ch = qq[qi];
    let found = -1;
    if (prev >= 0 && t[prev + 1] === ch && fits(qq, qi + 1, t, prev + 2)) found = prev + 1;
    if (found < 0) {
      for (let k = t.indexOf(ch, ti); k >= 0; k = t.indexOf(ch, k + 1)) {
        if (isBoundary(t, k) && fits(qq, qi + 1, t, k + 1)) { found = k; break; }
      }
    }
    if (found < 0) found = t.indexOf(ch, ti);
    score += 10;
    if (found === prev + 1) score += 15;
    if (isBoundary(t, found)) score += 20;
    score -= Math.min(found - ti, 10);
    indices.push(found);
    prev = found;
    ti = found + 1;
  }
  return { score: score - t.length * 0.2, indices };
}

/** Best match over a primary label and optional extra keywords (keywords never highlight). */
export function fuzzyScore(query: string, label: string, keywords = ""): FuzzyMatch | null {
  const main = fuzzyMatch(query, label);
  if (main) return main;
  if (!keywords) return null;
  const extra = fuzzyMatch(query, keywords);
  return extra ? { score: extra.score - 300, indices: [] } : null;
}
