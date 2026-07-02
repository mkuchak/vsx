export type MatchRange = [number, number];

export interface ScoredMatch {
  score: number;
  labelMatches: MatchRange[];
  descriptionMatches: MatchRange[];
}

export interface FuzzyItem {
  label: string;
  description?: string;
}

const TIER_EXACT = 1 << 18; // 262144
const TIER_PREFIX = 1 << 17; // 131072
const TIER_CONTAINS = 1 << 16; // 65536

// Char codes for separator classification.
const SLASH = 47; // /
const BACKSLASH = 92; // \
const UNDERSCORE = 95; // _
const DASH = 45; // -
const DOT = 46; // .
const SPACE = 32; //
const SQUOTE = 39; // '
const DQUOTE = 34; // "
const COLON = 58; // :

function isUpper(code: number): boolean {
  return code >= 65 && code <= 90;
}

function isLower(code: number): boolean {
  return code >= 97 && code <= 122;
}

function isPathSeparator(code: number): boolean {
  return code === SLASH || code === BACKSLASH;
}

function isOtherSeparator(code: number): boolean {
  return (
    code === UNDERSCORE ||
    code === DASH ||
    code === DOT ||
    code === SPACE ||
    code === SQUOTE ||
    code === DQUOTE ||
    code === COLON
  );
}

// Fast subsequence pre-check for early bailout on non-matching items.
function isSubsequence(queryLower: string, targetLower: string): boolean {
  const qLen = queryLower.length;
  const tLen = targetLower.length;
  if (qLen > tLen) return false;
  let qi = 0;
  for (let ti = 0; ti < tLen && qi < qLen; ti++) {
    if (queryLower[qi] === targetLower[ti]) qi++;
  }
  return qi === qLen;
}

interface RawMatch {
  score: number;
  positions: number[];
}

// VSCode-style DP subsequence matcher with the task's char/run bonuses.
function fuzzyMatch(
  query: string,
  queryLower: string,
  target: string,
  targetLower: string,
): RawMatch | null {
  const M = queryLower.length;
  const N = targetLower.length;
  if (M === 0 || M > N) return null;
  if (!isSubsequence(queryLower, targetLower)) return null;

  const scores = new Int32Array(M * N);
  const seq = new Int32Array(M * N); // consecutive run length ending at cell

  for (let qi = 0; qi < M; qi++) {
    const rowOff = qi * N;
    const prevOff = rowOff - N;
    const qChar = query[qi];
    const qLowerChar = queryLower[qi];

    for (let ti = 0; ti < N; ti++) {
      const cur = rowOff + ti;
      const leftScore = ti > 0 ? scores[cur - 1] : 0;
      const diagScore = qi > 0 && ti > 0 ? scores[prevOff + ti - 1] : 0;
      const seqLen = qi > 0 && ti > 0 ? seq[prevOff + ti - 1] : 0;

      let charScore = 0;
      // For non-first query chars, only score if the previous query chars
      // already matched in-sequence before this position (diagScore > 0).
      if (!(qi > 0 && diagScore === 0) && qLowerChar === targetLower[ti]) {
        charScore = 1; // base match

        // Consecutive-run bonus. Total over a run of length L is
        // min(L,3)*6 + max(0,L-3)*3, applied only to actual runs (L>=2) so that
        // an isolated match earns nothing here — this is what makes a contiguous
        // run outrank the same characters scattered. Added incrementally as the
        // run grows: the deltas 12, 6, 3, 3, ... produce totals 12, 18, 21, 24.
        const runLen = seqLen + 1;
        if (runLen === 2) charScore += 12;
        else if (runLen === 3) charScore += 6;
        else if (runLen >= 4) charScore += 3;

        // Same-case match bonus.
        if (qChar === target[ti]) charScore += 1;

        // Positional bonuses (mutually exclusive).
        if (ti === 0) {
          charScore += 8; // start of word
        } else {
          const prevCode = target.charCodeAt(ti - 1);
          if (isPathSeparator(prevCode)) {
            charScore += 5;
          } else if (isOtherSeparator(prevCode)) {
            charScore += 4;
          } else if (isLower(prevCode) && isUpper(target.charCodeAt(ti))) {
            charScore += 2; // camelCase boundary
          }
        }
      }

      const combined = diagScore + charScore;
      if (charScore > 0 && combined >= leftScore) {
        scores[cur] = combined;
        seq[cur] = seqLen + 1;
      } else {
        scores[cur] = leftScore;
        seq[cur] = 0;
      }
    }
  }

  // Trace back through the `seq` array to recover matched target indices.
  const positions: number[] = [];
  let qi = M - 1;
  let ti = N - 1;
  while (qi >= 0 && ti >= 0) {
    if (seq[qi * N + ti] === 0) {
      ti--; // this cell carried the score from the left
    } else {
      positions.push(ti);
      qi--;
      ti--;
    }
  }
  positions.reverse();

  return { score: scores[M * N - 1], positions };
}

// Merge sorted, ascending target indices into [start, end) ranges.
function toRanges(positions: number[]): MatchRange[] {
  if (positions.length === 0) return [];
  const ranges: MatchRange[] = [];
  let start = positions[0]!;
  let end = start + 1;
  for (let i = 1; i < positions.length; i++) {
    const p = positions[i]!;
    if (p === end) {
      end++;
    } else {
      ranges.push([start, end]);
      start = p;
      end = p + 1;
    }
  }
  ranges.push([start, end]);
  return ranges;
}

export function scoreItem(query: string, item: FuzzyItem): ScoredMatch | null {
  if (query.length === 0) return null;

  const queryLower = query.toLowerCase();
  const label = item.label;
  const labelLower = label.toLowerCase();

  const labelRes = fuzzyMatch(query, queryLower, label, labelLower);
  if (labelRes) {
    let score: number;
    if (queryLower === labelLower) {
      score = TIER_EXACT + labelRes.score;
    } else if (labelLower.startsWith(queryLower)) {
      const boost = Math.round((queryLower.length / labelLower.length) * 100);
      score = TIER_PREFIX + boost + labelRes.score;
    } else {
      score = TIER_CONTAINS + labelRes.score;
    }
    return {
      score,
      labelMatches: toRanges(labelRes.positions),
      descriptionMatches: [],
    };
  }

  const description = item.description;
  if (description) {
    const descLower = description.toLowerCase();
    const descRes = fuzzyMatch(query, queryLower, description, descLower);
    if (descRes) {
      // Clamp below TIER_CONTAINS so any label match always outranks a
      // description-only match.
      return {
        score: Math.min(descRes.score, TIER_CONTAINS - 1),
        labelMatches: [],
        descriptionMatches: toRanges(descRes.positions),
      };
    }
  }

  return null;
}

export interface ScoredResult<T> {
  item: T;
  score: number;
  labelMatches: MatchRange[];
  descriptionMatches: MatchRange[];
}

export function scoreAndSort<T>(
  query: string,
  items: T[],
  getLabel: (item: T) => FuzzyItem,
): ScoredResult<T>[] {
  if (query.length === 0) {
    return items.map((item) => ({
      item,
      score: 0,
      labelMatches: [],
      descriptionMatches: [],
    }));
  }

  const results: ScoredResult<T>[] = [];
  for (const item of items) {
    const res = scoreItem(query, getLabel(item));
    if (res) {
      results.push({
        item,
        score: res.score,
        labelMatches: res.labelMatches,
        descriptionMatches: res.descriptionMatches,
      });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}
