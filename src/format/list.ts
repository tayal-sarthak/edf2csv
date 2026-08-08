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
 *     listed(rates200)                          -> '200 Hz, 199 Hz, ... 193 Hz and 192 more'
 */
export function listed(items: readonly string[], limit = DEFAULT_LIMIT): string {
  if (items.length <= limit) return items.join(', ');
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
  return `${n} ${n === 1 ? singular : plural}`;
}
