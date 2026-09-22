// [LAW:effects-at-boundaries] Pure wire-format codec: REW's base64 float arrays <-> numbers.
// No I/O here; the client feeds strings in, typed arrays come out.

/**
 * REW transfers sample arrays as base64 over the raw bytes of big-endian
 * IEEE-754 float32 values. Big-endian is the trap: naive Float32Array reads
 * on x86/ARM are little-endian and produce plausible-looking garbage.
 */
export function decodeFloats(base64: string): Float64Array {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length % 4 !== 0) {
    // [LAW:no-silent-failure] a truncated array means corrupt data, not "fewer samples"
    throw new Error(
      `REW float array: decoded byte length ${bytes.length} is not a multiple of 4`,
    );
  }
  const out = new Float64Array(bytes.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = bytes.readFloatBE(i * 4);
  return out;
}

/** Inverse of {@link decodeFloats}, for endpoints that accept sample data. */
export function encodeFloats(values: ArrayLike<number>): string {
  const bytes = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i++) bytes.writeFloatBE(values[i], i * 4);
  return bytes.toString("base64");
}

/**
 * Parse a REW JSON payload, which is not quite JSON: REW writes Java's `NaN`,
 * `Infinity` and `-Infinity` as bare literals, and JSON.parse rejects all three.
 * A running SPL meter with no signal answers `"spl": NaN` — verified live against
 * REW 5.40 beta 132 — so read_spl used to die on the raw text with a Zod
 * "expected object, received string", exactly when a user is asking why there is
 * no signal.
 *
 * Non-finite becomes null: "there is no reading" said in a way a consumer can
 * test, rather than a number standing in for absence. [LAW:parse-dont-validate]
 * the dialect is normalised once, here, so nothing downstream meets a bare NaN.
 */
export function parseRewJson(text: string): unknown {
  // The alternation consumes whole strings first, so a "NaN" inside a string value
  // is matched as part of that string and returned untouched; only bare tokens in
  // value position reach the capture group.
  return JSON.parse(text.replace(/"(?:[^"\\]|\\.)*"|(-?Infinity|NaN)/g, (m, bare) => (bare ? "null" : m)));
}
