const OMIT = Symbol("json-omit");
const MAX_OWN_KEYS = 24 * 1024;
const MAX_ARRAY_LENGTH = 24 * 1024;

type JsonPrimitive = null | boolean | number | string;
interface JsonArray extends Array<JsonValue> {}
interface JsonRecord {
  [key: string]: JsonValue;
}
type JsonValue = JsonPrimitive | JsonArray | JsonRecord;
type Projection = JsonValue | typeof OMIT;

interface ProjectionContext {
  active: WeakSet<object>;
  maximumBytes: number;
  rawBytes: number;
}

export interface OwnDataJson {
  /** Exact detached JSON body; inherited and own serialization hooks are inert. */
  json: string;
  /** Detached own-data projection used for validation after serialization. */
  value: unknown;
}

const ownDescriptors = (value: object): PropertyDescriptor[] | undefined => {
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_OWN_KEYS) return;
  const descriptors: PropertyDescriptor[] = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return;
    descriptors.push(descriptor);
  }
  return descriptors;
};

const consumeRawText = (context: ProjectionContext, value: string) => {
  if (!Number.isFinite(context.maximumBytes)) return true;
  context.rawBytes += Buffer.byteLength(value, "utf8");
  return context.rawBytes <= context.maximumBytes;
};

const projection = (
  value: unknown,
  context: ProjectionContext,
): Projection | undefined => {
  switch (typeof value) {
    case "string":
      return consumeRawText(context, value) ? value : undefined;
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "undefined":
    case "function":
    case "symbol":
      return OMIT;
    case "bigint":
      return;
    case "object":
      break;
    default:
      return;
  }
  if (value === null) return null;
  if (context.active.has(value)) return;
  context.active.add(value);
  try {
    return Array.isArray(value)
      ? projectArray(value, context)
      : projectRecord(value, context);
  } finally {
    context.active.delete(value);
  }
};

const projectArray = (
  value: unknown[],
  context: ProjectionContext,
): Projection | undefined => {
  const descriptors = ownDescriptors(value);
  if (!descriptors || value.length > MAX_ARRAY_LENGTH) return;
  const result: JsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor) {
      // JSON arrays serialize holes as null. Never read inherited indexes.
      result.push(null);
      continue;
    }
    if (!("value" in descriptor)) return;
    const child = projection(descriptor.value, context);
    if (child === undefined) return;
    result.push(child === OMIT ? null : child);
  }
  // JSON.stringify reads array.toJSON first. Shadow inherited hooks explicitly.
  Object.defineProperty(result, "toJSON", {
    value: undefined,
    enumerable: false,
  });
  return result;
};

const projectRecord = (
  value: object,
  context: ProjectionContext,
): Projection | undefined => {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return;
  const descriptors = ownDescriptors(value);
  if (!descriptors) return;
  const result = Object.create(null) as Record<string, JsonValue>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return;
    if (!descriptor.enumerable) continue;
    const child = projection(descriptor.value, context);
    if (child === undefined) return;
    if (child !== OMIT) {
      if (!consumeRawText(context, key)) return;
      result[key] = child;
    }
  }
  return result;
};

/**
 * Serialize ordinary JSON own-data without consulting any toJSON/getter hook.
 * Undefined/functions/symbols retain JSON's object-omit and array-null rules.
 */
export const ownDataJson = (
  value: unknown,
  maximumBytes = Number.POSITIVE_INFINITY,
): OwnDataJson | undefined => {
  try {
    if (maximumBytes < 0 || Number.isNaN(maximumBytes)) return;
    const projected = projection(value, {
      active: new WeakSet<object>(),
      maximumBytes,
      rawBytes: 0,
    });
    if (projected === undefined || projected === OMIT) return;
    const json = JSON.stringify(projected);
    return typeof json === "string" ? { json, value: projected } : undefined;
  } catch {
    return;
  }
};
