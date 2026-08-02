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

  The default (`ignoreBOM: false`) removes a leading EF BB BF, which `Buffer.toString('utf8')` does
  not. That is the single input class where the two disagree — everything else, including every
  malformed sequence, already matches. No EDF file reaches it today, because the only caller guards
  on the first byte being '+' or '-' before decoding a TAL, but this function is written to stand in
  for Buffer's UTF-8 decoding and should not have a silent exception to that.
*/
const UTF8 = new TextDecoder('utf-8', { ignoreBOM: true });

/** Decode bytes as UTF-8, substituting U+FFFD for malformed sequences as Buffer does. */
export function decodeUtf8(bytes: Uint8Array): string {
  return UTF8.decode(bytes);
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
