/**
 * The primitive encodings of the WebAssembly binary format.
 *
 * Everything in a wasm module is built from four things: LEB128 integers,
 * length-prefixed vectors, length-prefixed sections, and raw little-endian
 * floats. Getting these right is most of the work; the rest of the emitter is
 * choosing opcodes.
 *
 * Reference: https://webassembly.github.io/spec/core/binary/index.html
 */

export type Bytes = number[];

export const MAGIC: Bytes = [0x00, 0x61, 0x73, 0x6d]; // "\0asm"
export const VERSION: Bytes = [0x01, 0x00, 0x00, 0x00];

/** Unsigned LEB128: seven bits per byte, high bit set while more follow. */
export function uleb128(value: number): Bytes {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`uleb128 expects a non-negative integer, got ${value}`);
  }

  const bytes: Bytes = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);

  return bytes;
}

/**
 * Signed LEB128. The termination rule is what catches people out: stop only
 * once the remaining value is all sign bits *and* the sign bit of the last
 * byte agrees, otherwise the value is read back with the wrong sign.
 */
export function sleb128(value: number): Bytes {
  if (!Number.isInteger(value)) {
    throw new RangeError(`sleb128 expects an integer, got ${value}`);
  }

  const bytes: Bytes = [];
  let remaining = value;

  for (;;) {
    const byte = remaining & 0x7f;
    // Arithmetic shift, so negative values fill with ones.
    remaining >>= 7;

    const signBit = (byte & 0x40) !== 0;
    const done = (remaining === 0 && !signBit) || (remaining === -1 && signBit);

    bytes.push(done ? byte : byte | 0x80);
    if (done) return bytes;
  }
}

/** IEEE 754 double, little-endian, as wasm's f64.const immediate. */
export function f64Bytes(value: number): Bytes {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, true);
  return [...new Uint8Array(buffer)];
}

/** A vector: element count followed by the concatenated elements. */
export function vector(elements: readonly Bytes[]): Bytes {
  return [...uleb128(elements.length), ...elements.flat()];
}

/** UTF-8 bytes with a length prefix, as used for export names. */
export function encodeName(text: string): Bytes {
  const encoded = [...new TextEncoder().encode(text)];
  return [...uleb128(encoded.length), ...encoded];
}

/** A section: id, byte length, payload. */
export function section(id: number, payload: Bytes): Bytes {
  if (payload.length === 0) return [];
  return [id, ...uleb128(payload.length), ...payload];
}

export const SectionId = {
  type: 1,
  function: 3,
  export: 7,
  code: 10,
} as const;
