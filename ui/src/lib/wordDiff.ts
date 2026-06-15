// Word-level intra-line diff. Given the old and new text of a modified line, returns
// the character ranges that actually changed on each side, so the diff can highlight
// just the edited words rather than tinting the whole line. Pure + side-effect free.

export type Range = [start: number, end: number];

// Split into word tokens (runs of word chars) and single non-word chars, preserving
// every character so offsets reconstruct exactly.
function tokenize(s: string): string[] {
  return s.match(/\w+|\W/g) ?? [];
}

const MAX_TOKENS = 400; // skip word-diff on pathological lines (minified, huge)

// Longest common subsequence over two token arrays → aligned ops. Classic DP; lines
// are short so this is cheap, and we bail on very long token arrays.
function lcsRanges(a: string[], b: string[]): { oldRanges: Range[]; newRanges: Range[] } {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const oldRanges: Range[] = [];
  const newRanges: Range[] = [];
  let i = 0;
  let j = 0;
  let oldOff = 0;
  let newOff = 0;

  const pushOld = (len: number) => {
    const last = oldRanges[oldRanges.length - 1];
    if (last && last[1] === oldOff) {
      last[1] = oldOff + len;
    } else {
      oldRanges.push([oldOff, oldOff + len]);
    }
  };
  const pushNew = (len: number) => {
    const last = newRanges[newRanges.length - 1];
    if (last && last[1] === newOff) {
      last[1] = newOff + len;
    } else {
      newRanges.push([newOff, newOff + len]);
    }
  };

  while (i < n && j < m) {
    if (a[i] === b[j]) {
      oldOff += a[i].length;
      newOff += b[j].length;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pushOld(a[i].length);
      oldOff += a[i].length;
      i++;
    } else {
      pushNew(b[j].length);
      newOff += b[j].length;
      j++;
    }
  }
  while (i < n) {
    pushOld(a[i].length);
    oldOff += a[i].length;
    i++;
  }
  while (j < m) {
    pushNew(b[j].length);
    newOff += b[j].length;
    j++;
  }
  return { oldRanges, newRanges };
}

// The changed character ranges on each side of a modified line pair. Returns empty
// ranges when the lines are identical or too long to diff cheaply.
export function diffWords(
  oldStr: string,
  newStr: string,
): { oldRanges: Range[]; newRanges: Range[] } {
  if (oldStr === newStr) {
    return { oldRanges: [], newRanges: [] };
  }
  const a = tokenize(oldStr);
  const b = tokenize(newStr);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    return { oldRanges: [], newRanges: [] };
  }
  return lcsRanges(a, b);
}
