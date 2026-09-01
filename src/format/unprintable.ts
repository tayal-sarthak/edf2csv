/**
 * Text that a terminal does not print as itself, and how it is shown instead.
 *
 * Two kinds, and they fail differently. A control byte drives the terminal: `\x1b[2J\x1b[H`
 * clears the screen and homes the cursor, which is enough to hide output or repaint it as
 * something else. A bidirectional override does not drive it at all — it tells the terminal
 * to display a run right to left and to keep doing so until the run closes, so a file named
 * `sleep-` then U+202E then `fdp.edf` arrives on screen as `sleep-fde.pdf`. Neither is a
 * byte anyone types on purpose, and in both cases what is shown is not what is there.
 *
 * Named rather than written. This paragraph carried the override itself until 0.8.17, so
 * every line after it in the file that defines the class rendered right to left in a
 * terminal: the hazard, in the source that exists to keep it off a screen. The changelog
 * had the same byte taken out of it twice, in the entries for 0.7.257 and 0.8.0, for the
 * same reason and by the same rule: write the name, not the character.
 *
 * One class, in one place, because three callers need the same answer: `printable` escapes it
 * before a path or a header field reaches the terminal, and the conversion asks whether an
 * annotation description carries any, since that column is the one piece of free text in the
 * output that can hold a character above U+00FF — header text is decoded latin1, so every
 * byte of it becomes a code point below U+0100.
 *
 * Not the bidi marks U+200E and U+200F, which reorder the neutral characters beside them
 * rather than a run, and which do turn up in ordinary names and event text written in Arabic
 * or Hebrew.
 */
const UNPRINTABLE = '\\u0000-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069';

/** Fresh each time, because a `g` flag carries `lastIndex` between calls. */
export function unprintablePattern(flags = 'u'): RegExp {
  return new RegExp(`[${UNPRINTABLE}]`, flags);
}

/**
 * One character as its escape.
 *
 * `\x` is two digits and `\u` is four, so the wide ones take `\u`: a reader who counts the
 * digits of `\x202e` finds a different character.
 */
export function escapeCharacter(character: string): string {
  const code = character.codePointAt(0) as number;
  return code > 0xff ? `\\u${code.toString(16)}` : `\\x${code.toString(16).padStart(2, '0')}`;
}

/** Every distinct unprintable character in `text`, in the order they first appear. */
export function unprintableIn(text: string): string[] {
  const found = new Set<string>();
  const single = unprintablePattern();
  for (const character of text) if (single.test(character)) found.add(character);
  return [...found];
}
