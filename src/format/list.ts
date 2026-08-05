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
