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
