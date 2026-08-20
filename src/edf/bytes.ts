/**
 * Byte decoding for the parser, written against `Uint8Array` rather than `Buffer`.
 *
 * The parser used to lean on `Buffer` methods, which put the `Buffer` type into the
 * published `.d.ts` files and forced every TypeScript consumer to have `@types/node`
 * installed to compile. Nothing here needs Node: these are the three operations the
 * EDF reader actually performed on raw bytes.
 */

/**
 * Decode bytes as latin1: each byte becomes the code point of the same value.
 *
 * Written as an explicit loop rather than `TextDecoder('latin1')` because the identity
 * mapping is the property this parser needs, and doing it directly guarantees it rather
 * than inheriting it. The WHATWG Encoding Standard lists `latin1` as a label for
 * windows-1252, which is not an identity map over 0x80-0x9F; Node resolves the label to
 * plain byte identity, so the two agree here, but that is a runtime's behaviour rather
 * than a guarantee to lean on for header bytes.
 *
 * Verified byte-for-byte against `Buffer.toString('latin1')` across all 256 values.
 */
export function decodeLatin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  // Built in chunks so the spread never approaches the engine's argument-count limit.
  const CHUNK = 4096;
  let out = '';
  for (let i = start; i < end; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, end)));
  }
  return out;
}

/*
  `ignoreBOM: true` is the non-obvious part, and it means the opposite of how it reads: it tells the
  decoder to treat a leading U+FEFF as ordinary text rather than as a byte-order mark to strip.

  The default (`ignoreBOM: false`) removes a leading EF BB BF, which no reader of this text asked
  for: a mark at the front of an annotation is a character the file holds, and dropping it would be
  the same kind of quiet edit `decodeText` below exists to avoid. No EDF file reaches it today,
  because the only caller guards on the first byte being '+' or '-' before decoding a TAL.

  `fatal: true` is what makes the fallback below decidable rather than guessed: malformed input
  throws instead of coming back with U+FFFD substituted for it.
*/
const UTF8_STRICT = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });

/**
 * Decode free text out of a data record: UTF-8 where the bytes are UTF-8, latin1 where not.
 *
 * EDF+ says the annotation channel holds UTF-8, and this decoded it as UTF-8 and took what
 * came back. What comes back for bytes that are not UTF-8 is U+FFFD, one per malformed
 * sequence — so an event described `café` by a recorder writing latin1, which is most of the
 * older ones, was exported as `caf\uFFFD`. A character the file does not contain, in a text
 * column, with nothing said and exit 0.
 *
 * The same byte in a channel label comes out `é`, because header text is decoded by
 * `decodeLatin1` above, whose whole point is that every byte becomes the code point of the
 * same value. Two encodings for free text out of one file, and the difference only shows on
 * the side that can invent a character.
 *
 * Strict first, so the question is answered rather than guessed: bytes that decode as UTF-8
 * are UTF-8, and there is no ambiguity to resolve — a file may hold a genuine U+FFFD, written
 * `EF BF BD`, and that is valid UTF-8 and decodes to itself. Bytes that do not decode are not
 * UTF-8, and latin1 is what the rest of this parser reads them as. Neither path invents
 * anything: latin1 cannot fail, and it is the identity map this file already documents.
 */
export function decodeText(bytes: Uint8Array): string {
  try {
    return UTF8_STRICT.decode(bytes);
  } catch {
    return decodeLatin1(bytes);
  }
}

/**
 * Read a signed 16-bit little-endian sample.
 *
 * Plain arithmetic rather than a `DataView`: this runs once per sample, so hundreds of
 * millions of times on a long recording, and allocating or retaining a view per call
 * would show up in the conversion time. Shifting left 16 and back down arithmetically
 * is what sign-extends the result.
 */
export function readInt16LE(bytes: Uint8Array, position: number): number {
  const lo = bytes[position] as number;
  const hi = bytes[position + 1] as number;
  return (((lo | (hi << 8)) << 16) >> 16);
}
