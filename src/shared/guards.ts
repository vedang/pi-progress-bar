import type { SourceRef } from "../core/hybrid-state";

type DataRecord = Record<string, unknown>;

const SHA256 = /^[a-f0-9]{64}$/;

export const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Any non-null, non-array object; prototype is not checked. */
export const record = (value: unknown): value is DataRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Object-prototype record whose own properties are all enumerable data properties. */
export const plainDataRecord = (value: unknown): value is DataRecord => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => "value" in descriptor && descriptor.enumerable,
  );
};

/** Enumerable string keys are exactly `keys`; symbols and non-enumerables are not counted. */
export const exactKeys = (value: DataRecord, keys: readonly string[]) => {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
};

/** Every own key, including symbols and non-enumerables, is exactly `keys`. */
export const exactOwnKeys = (value: DataRecord, keys: readonly string[]) => {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === "string" && keys.includes(key))
  );
};

/** Plain data record with all `required` keys and no own keys outside `required` and `optional`. */
export const hasExactKeys = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is DataRecord => {
  if (!plainDataRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  return (
    keys.length >= required.length &&
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => typeof key === "string" && allowed.has(key))
  );
};

/** Lowercase hex SHA-256; the length check keeps oversized input away from the regex. */
export const validHash = (value: unknown): value is string =>
  typeof value === "string" && value.length === 64 && SHA256.test(value);

export const safeInteger = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;

export const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

export const nonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Finite number in [0, 1]. */
export const unit = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;

/** Freeze an object graph in place; cycles and shared children are visited once. */
export const deepFreeze = <Value>(
  value: Value,
  seen = new WeakSet<object>(),
): Value => {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

export const deeplyFrozen = (
  value: unknown,
  seen = new WeakSet<object>(),
): boolean => {
  if (!value || typeof value !== "object" || seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Object.values(value).every((child) => deeplyFrozen(child, seen));
};

/** Detached copy of exactly the SourceRef fields. */
export const cloneSource = (source: SourceRef): SourceRef => ({
  entryId: source.entryId,
  messageHash: source.messageHash,
  role: source.role,
  start: source.start,
  end: source.end,
  quoteHash: source.quoteHash,
});

export const sameSource = (left: SourceRef, right: SourceRef) =>
  left.entryId === right.entryId &&
  left.messageHash === right.messageHash &&
  left.role === right.role &&
  left.start === right.start &&
  left.end === right.end &&
  left.quoteHash === right.quoteHash;
