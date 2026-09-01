/**
 * Rendering a set of things inside a sentence, without letting the file decide how long
 * the sentence gets.
 *
 * Several messages enumerate something the recording controls: its sampling rates, its
 * channel positions. On an ordinary file that is a handful of items and listing them all is
 * exactly right — the rates are what `--channels` has to choose between, so naming them is
 * the whole use of the message. On a file with two hundred channels the same code produced a
 * single 1,600-character line:
 *
 *     warning: Channels use 200 different sampling rates (200 Hz, 199 Hz, 198 Hz, ... 1 Hz).
 *
 * which wraps across a whole terminal and buries the sentence that mattered. Nothing was
 * wrong with the conversion; the message was simply unreadable at a size the header is free
 * to ask for.
 */

/** How many items a message shows before summarising the rest. */
const DEFAULT_LIMIT = 8;

/**
 * Join items for a sentence, keeping at most `limit` of them.
 *
 * Beyond the limit the remainder is counted rather than named. The count is the honest part:
 * it says the list was cut without pretending the tail does not exist.
 *
 *     listed(['1 Hz', '2 Hz'])                  -> '1 Hz, 2 Hz'
 *     listed(rates9)                            -> all nine; see below
 *     listed(rates200)                          -> '200 Hz, 199 Hz, ... 193 Hz and 192 more'
 */
export function listed(items: readonly string[], limit = DEFAULT_LIMIT): string {
  /*
    One item over the limit is shown rather than counted.

    "and 1 more" is eleven characters standing in for a single item, and an item is rarely
    that long. Nine sampling rates came out as

        Channels use 9 different sampling rates (100 Hz, 99 Hz, 98 Hz, 97 Hz, 96 Hz,
        95 Hz, 94 Hz, 93 Hz and 1 more).

    which is four characters longer than naming all nine and one rate shorter — while the
    sentence around it has already said there are nine, so the reader is told the count and
    then denied the item. A cut that costs more than it hides is not a cut.

    Two is where it starts paying: ", 92 Hz, 91 Hz" against " and 2 more". Beyond that it is
    the whole point.
  */
  if (items.length <= limit + 1) return items.join(', ');
  const shown = items.slice(0, limit).join(', ');
  return `${shown} and ${items.length - limit} more`;
}

/**
 * A count and its noun, agreeing.
 *
 * Every one of these was written `${n} records`, which is right until the file has one of
 * them — and a one-record recording, a one-byte tail and a batch of one are all ordinary.
 * `--info` opened with "Duration 1s  (1 records of 1s)" and a truncated file warned that
 * "1 bytes after the last complete data record were ignored". Small, and on the two lines a
 * reader looks at first.
 *
 * The plural is `<singular>s` unless given, since English mostly cooperates here and the
 * exceptions in this codebase — "entries" — are spelled out at the call site.
 *
 *     counted(1, 'record')            -> '1 record'
 *     counted(4, 'record')            -> '4 records'
 *     counted(1, 'entry', 'entries')  -> '1 entry'
 */
export function counted(n: number, singular: string, plural = `${singular}s`): string {
  return `${grouped(n)} ${n === 1 ? singular : plural}`;
}

/**
 * A count, in the digit grouping the rest of this tool's counts are printed in.
 *
 * `--info` printed two counts of the same recording ten lines apart:
 *
 *     Duration   8h 00m 0s  (28800 records of 1s)
 *     Would write 3,196,800 rows, roughly 108 MB.
 *
 * and the warning under them, "more than 1,048,576 rows, which is more than Excel or Numbers
 * can open", made three. Row counts were grouped because they were written that way; every
 * count that went through `counted` was not, because it was written the other way. Nothing
 * decided that — the two were never compared.
 *
 * Which matters most where two figures sit in one sentence to be compared against each
 * other: "The file contains 39321 bytes of data, which is less than the 65536 its header
 * says one data record takes" is a subtraction the reader is being asked to do by eye.
 *
 * Named so the neighbours of a `counted` call can be printed the same way without a third
 * copy of the locale string, and so there is one place to change if that is ever wrong.
 */
export function grouped(n: number): string {
  return n.toLocaleString('en-US');
}
