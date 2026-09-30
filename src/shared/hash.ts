import { createHash } from "node:crypto";

/** Hex SHA-256 of the UTF-8 encoding of `value`. */
export const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** `JSON.stringify`, with throws (cycles, BigInt, hostile toJSON) mapped to undefined. */
export const json = (value: unknown): string | undefined => {
  try {
    return JSON.stringify(value);
  } catch {
    return;
  }
};

export const jsonBytes = (value: unknown): number | undefined => {
  const serialized = json(value);
  return serialized === undefined
    ? undefined
    : Buffer.byteLength(serialized, "utf8");
};

/** SHA-256 of the JSON form; undefined when not serializable. */
export const requestHash = (request: unknown): string | undefined => {
  const serialized = json(request);
  return serialized === undefined ? undefined : sha256(serialized);
};
