import { describe, expect, it } from "vitest";
import { decodeFloats, encodeFloats } from "./codec.js";

describe("codec", () => {
  // Validation vector published in REW's own API documentation.
  const rewDocBase64 = "PgAAAD6AAAA+wAAAPwAAAA==";
  const rewDocFloats = [0.125, 0.25, 0.375, 0.5];

  it("decodes REW's documented test vector", () => {
    expect(Array.from(decodeFloats(rewDocBase64))).toEqual(rewDocFloats);
  });

  it("round-trips through encode", () => {
    expect(decodeFloats(encodeFloats(rewDocFloats))).toEqual(Float64Array.from(rewDocFloats));
  });

  it("decodes an empty array", () => {
    expect(decodeFloats("").length).toBe(0);
  });

  it("rejects byte lengths that are not multiples of 4", () => {
    const truncated = Buffer.from([0x3e, 0x00, 0x00]).toString("base64");
    expect(() => decodeFloats(truncated)).toThrow(/multiple of 4/);
  });

  it("preserves big-endian byte order (not platform order)", () => {
    // 1.0f big-endian is 3F 80 00 00; little-endian misread would give 4.6e-41.
    const one = Buffer.from([0x3f, 0x80, 0x00, 0x00]).toString("base64");
    expect(decodeFloats(one)[0]).toBe(1);
  });
});
