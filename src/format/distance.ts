/**
 * Edit distance counting a swap of two adjacent characters as one edit, not two.
 *
 * Damerau's restricted form, which needs the row two back and so keeps three rather than the
 * two plain Levenshtein needs. The strings compared here are option names and channel labels,
 * none of them long, so the extra row costs nothing worth measuring.
 *
 * Shared because a transposition is the commonest typo there is and the two callers were
 * disagreeing about it. 0.7.232 made the option suggester count `--hlep` as one edit from
 * `--help`, and gave its reasoning: plain Levenshtein charges two, which put `--hlep`,
 * `--jsno` and `--gzpi` past the allowance and answered them with nothing at all. Channel
 * names kept their own copy of the two-row version, and they are the side a person actually
 * types by hand — long, unfamiliar and copied off a screen. On a recording carrying `EEG` and
 * `ECG`, `--channels EGC` scored two against both, so the tie was broken by file order and the
 * answer was
 *
 *     No channel named "EGC". Did you mean "EEG", "ECG"?
 *
 * naming the wrong one first. `suggest` in convert/channels.ts has a comment about precisely
 * that outcome — "a suggestion that is retypeable, close, and about the wrong signal. Taking
 * it converts a heart trace under the belief it is an EEG, and the run succeeds."
 */
export function editDistance(a: string, b: string): number {
  let twoBack: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_unused, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = new Array<number>(b.length + 1).fill(0);
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, (twoBack[j - 2] as number) + 1);
      }
      current[j] = best;
    }
    twoBack = previous;
    previous = current;
  }
  return previous[b.length] as number;
}
