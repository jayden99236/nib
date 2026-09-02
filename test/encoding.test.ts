import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { encodeName, f64Bytes, section, sleb128, uleb128, vector } from "../src/wasm/encoding.js";

describe("uleb128", () => {
  test("small values are a single byte", () => {
    assert.deepEqual(uleb128(0), [0x00]);
    assert.deepEqual(uleb128(1), [0x01]);
    assert.deepEqual(uleb128(127), [0x7f]);
  });

  test("continues past seven bits", () => {
    assert.deepEqual(uleb128(128), [0x80, 0x01]);
    assert.deepEqual(uleb128(624485), [0xe5, 0x8e, 0x26]);
  });

  test("rejects negative values", () => {
    assert.throws(() => uleb128(-1), RangeError);
  });
});

describe("sleb128", () => {
  test("encodes small positives without a spurious sign byte", () => {
    assert.deepEqual(sleb128(0), [0x00]);
    assert.deepEqual(sleb128(1), [0x01]);
    assert.deepEqual(sleb128(63), [0x3f]);
  });

  test("adds a byte when the sign bit would flip the value", () => {
    // 64 has bit 6 set, which would read back as -64 in one byte.
    assert.deepEqual(sleb128(64), [0xc0, 0x00]);
  });

  test("encodes negatives", () => {
    assert.deepEqual(sleb128(-1), [0x7f]);
    assert.deepEqual(sleb128(-64), [0x40]);
    assert.deepEqual(sleb128(-65), [0xbf, 0x7f]);
    assert.deepEqual(sleb128(-123456), [0xc0, 0xbb, 0x78]);
  });

  test("round-trips through a decoder", () => {
    const decode = (bytes: number[]): number => {
      let result = 0;
      let shift = 0;
      let byte = 0;
      for (const current of bytes) {
        byte = current;
        result |= (byte & 0x7f) << shift;
        shift += 7;
      }
      if (shift < 32 && (byte & 0x40) !== 0) result |= -(1 << shift);
      return result;
    };

    for (const value of [0, 1, -1, 63, 64, -64, -65, 8191, -8192, 123456, -123456, 2 ** 20]) {
      assert.equal(decode(sleb128(value)), value, `round trip failed for ${value}`);
    }
  });
});

describe("f64Bytes", () => {
  test("is little-endian IEEE 754", () => {
    assert.deepEqual(f64Bytes(1), [0, 0, 0, 0, 0, 0, 0xf0, 0x3f]);
    assert.deepEqual(f64Bytes(0), [0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test("round-trips", () => {
    for (const value of [1.5, -0.25, 3.141592653589793, 1e308, -1e-308]) {
      const view = new DataView(new Uint8Array(f64Bytes(value)).buffer);
      assert.equal(view.getFloat64(0, true), value);
    }
  });
});

describe("vectors and sections", () => {
  test("a vector is a count followed by its elements", () => {
    assert.deepEqual(vector([[1, 2], [3]]), [2, 1, 2, 3]);
    assert.deepEqual(vector([]), [0]);
  });

  test("a section is id, byte length, payload", () => {
    assert.deepEqual(section(3, [1, 2, 3]), [3, 3, 1, 2, 3]);
  });

  test("an empty section is omitted entirely", () => {
    assert.deepEqual(section(3, []), []);
  });

  test("names are utf-8 with a length prefix", () => {
    assert.deepEqual(encodeName("main"), [4, 0x6d, 0x61, 0x69, 0x6e]);
    // Multi-byte characters are counted in bytes, not code points.
    assert.equal(encodeName("é")[0], 2);
  });
});
