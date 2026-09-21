import type { CorrectionAttempt } from "./corrections";

const MAX_CORRELATIONS = 256;
const MAX_ID_BYTES = 512;
const BUILTIN_SOURCE = {
  path: "<builtin:NAME>",
  source: "builtin",
  scope: "temporary",
  origin: "top-level",
} as const;
const SUBAGENT_SOURCE = {
  source: "git:github.com/nicobailon/pi-subagents",
  scope: "user",
  origin: "package",
} as const;
const SUBAGENT_PATH =
  /(?:^|\/)agent\/git\/github\.com\/nicobailon\/pi-subagents\/index\.ts$/;

type RecordValue = Record<string, unknown>;
type TestToolName = "write" | "edit";

export interface CorrectionAdapterOptions {
  tools(): readonly unknown[];
}

interface ReviewCorrelation {
  toolName: "subagent";
}

const record = (value: unknown): value is RecordValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const exactKeys = (value: RecordValue, keys: readonly string[]) => {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === "string" && keys.includes(key))
  );
};

const safeId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value, "utf8") <= MAX_ID_BYTES &&
  !/[\p{Cc}\p{Cf}]/u.test(value);

const schemaProperty = (
  parameters: RecordValue,
  name: string,
  type: string,
) => {
  if (parameters.type !== "object" || !record(parameters.properties))
    return false;
  const property = parameters.properties[name];
  return record(property) && property.type === type;
};

const requiredProperties = (
  parameters: RecordValue,
  names: readonly string[],
) => {
  const required = parameters.required;
  return (
    Array.isArray(required) &&
    required.length === names.length &&
    names.every((name) => required.includes(name))
  );
};

// Host schemas include TypeBox annotations; they do not change argument shape.
const schemaKeys = (value: RecordValue, keys: readonly string[]) =>
  keys.every((key) => key in value) &&
  Object.keys(value).every(
    (key) => keys.includes(key) || key === "description" || key === "~kind",
  );
const sourceKeys = (value: RecordValue) =>
  Object.keys(value).every((key) =>
    ["path", "source", "scope", "origin", "baseDir"].includes(key),
  ) &&
  (value.baseDir === undefined || typeof value.baseDir === "string");
const stringSchema = (value: unknown) =>
  record(value) && schemaKeys(value, ["type"]) && value.type === "string";

const builtinTool = (value: unknown, name: TestToolName) => {
  if (!record(value) || value.name !== name || !record(value.sourceInfo))
    return false;
  const source = value.sourceInfo;
  if (
    !sourceKeys(source) ||
    source.path !== BUILTIN_SOURCE.path.replace("NAME", name) ||
    source.source !== BUILTIN_SOURCE.source ||
    source.scope !== BUILTIN_SOURCE.scope ||
    source.origin !== BUILTIN_SOURCE.origin ||
    !record(value.parameters)
  )
    return false;
  const parameters = value.parameters;
  if (
    !schemaKeys(parameters, ["type", "properties", "required"]) ||
    !record(parameters.properties)
  )
    return false;
  const properties = parameters.properties;
  if (name === "write")
    return (
      exactKeys(properties, ["path", "content"]) &&
      stringSchema(properties.path) &&
      stringSchema(properties.content) &&
      requiredProperties(parameters, ["path", "content"])
    );
  const edits = properties.edits;
  return (
    exactKeys(properties, ["path", "edits"]) &&
    stringSchema(properties.path) &&
    record(edits) &&
    schemaKeys(edits, ["type", "items"]) &&
    edits.type === "array" &&
    record(edits.items) &&
    schemaKeys(edits.items, ["type", "properties", "required"]) &&
    edits.items.type === "object" &&
    record(edits.items.properties) &&
    exactKeys(edits.items.properties, ["oldText", "newText"]) &&
    stringSchema(edits.items.properties.oldText) &&
    stringSchema(edits.items.properties.newText) &&
    requiredProperties(edits.items, ["oldText", "newText"]) &&
    requiredProperties(parameters, ["path", "edits"])
  );
};

const subagentTool = (value: unknown) => {
  if (!record(value) || value.name !== "subagent" || !record(value.sourceInfo))
    return false;
  const source = value.sourceInfo;
  if (
    !sourceKeys(source) ||
    typeof source.path !== "string" ||
    !SUBAGENT_PATH.test(source.path) ||
    source.source !== SUBAGENT_SOURCE.source ||
    source.scope !== SUBAGENT_SOURCE.scope ||
    source.origin !== SUBAGENT_SOURCE.origin ||
    !record(value.parameters)
  )
    return false;
  const parameters = value.parameters;
  return (
    schemaProperty(parameters, "workflow", "string") &&
    schemaProperty(parameters, "args", "object") &&
    schemaProperty(parameters, "async", "boolean")
  );
};

const oneRegisteredTool = (
  tools: readonly unknown[],
  name: string,
  predicate: (tool: unknown) => boolean,
) => {
  const matches = tools.filter((tool) => record(tool) && tool.name === name);
  return matches.length === 1 && predicate(matches[0]);
};

const safeRelativePath = (value: unknown, cwd: unknown): string | undefined => {
  if (typeof value !== "string" || typeof cwd !== "string" || !cwd) return;
  if (
    !value ||
    Buffer.byteLength(value, "utf8") > 1024 ||
    value.includes("\\") ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  )
    return;
  const relative = value.startsWith("/")
    ? cwd.endsWith("/")
      ? value.slice(cwd.length)
      : value.startsWith(`${cwd}/`)
        ? value.slice(cwd.length + 1)
        : undefined
    : value;
  if (!relative || relative.startsWith("/") || relative.includes("\\")) return;
  const parts = relative.split("/");
  return parts.every((part) => part && part !== "." && part !== "..")
    ? relative
    : undefined;
};

const testStart = (
  toolName: TestToolName,
  args: unknown,
  cwd: unknown,
): { path: string } | undefined => {
  if (!record(args)) return;
  const valid =
    toolName === "write"
      ? exactKeys(args, ["path", "content"]) && typeof args.content === "string"
      : exactKeys(args, ["path", "edits"]) &&
        Array.isArray(args.edits) &&
        args.edits.every(
          (edit) =>
            record(edit) &&
            exactKeys(edit, ["oldText", "newText"]) &&
            typeof edit.oldText === "string" &&
            typeof edit.newText === "string",
        );
  if (!valid) return;
  const path = safeRelativePath(args.path, cwd);
  return path ? { path } : undefined;
};

const namedReviewStart = (args: unknown) =>
  record(args) &&
  exactKeys(args, ["workflow", "args", "async"]) &&
  args.workflow === "review" &&
  record(args.args) &&
  args.async === false;

const runningReviewReceipt = (
  callId: string,
  value: unknown,
): string | undefined => {
  if (!record(value) || !record(value.details)) return;
  const details = value.details;
  if (
    details.mode !== "workflow" ||
    !safeId(details.runId) ||
    !record(details.workflow) ||
    !record(details.workflow.resource) ||
    !record(details.workflowChildren)
  )
    return;
  const resource = details.workflow.resource;
  if (
    resource.kind !== "workflow" ||
    resource.name !== "review" ||
    resource.version !== 1 ||
    resource.invocation !== "named" ||
    resource.expansion !== "resolved" ||
    !safeId(resource.id)
  )
    return;
  const children = details.workflowChildren;
  if (
    children.version !== 1 ||
    children.parentToolCallId !== callId ||
    children.workflowRunId !== details.runId ||
    children.inventoryComplete !== false ||
    children.workflowState !== "running" ||
    !Array.isArray(children.children)
  )
    return;
  const child = children.children.find(
    (candidate) =>
      record(candidate) &&
      candidate.state === "running" &&
      safeId(candidate.runId),
  );
  return child && safeId(child.runId) ? child.runId : undefined;
};

/**
 * Reduces only installed, schema-verified tool events to controller-safe facts.
 * It never launches, blocks, cancels, or preserves tool/child text.
 */
export class CorrectionAdapter {
  private readonly reviews = new Map<string, ReviewCorrelation>();

  constructor(private readonly options: CorrectionAdapterOptions) {}

  start(
    callId: string,
    toolName: string,
    args: unknown,
    cwd: string,
  ): CorrectionAttempt | undefined {
    if (!safeId(callId)) return;
    let tools: readonly unknown[];
    try {
      tools = this.options.tools();
    } catch {
      return;
    }
    if (toolName === "write" || toolName === "edit") {
      const name = toolName as TestToolName;
      if (!oneRegisteredTool(tools, name, (tool) => builtinTool(tool, name)))
        return;
      const start = testStart(name, args, cwd);
      return start
        ? { kind: "test", id: callId, toolName: name, path: start.path }
        : undefined;
    }
    if (
      toolName !== "subagent" ||
      !oneRegisteredTool(tools, "subagent", subagentTool) ||
      !namedReviewStart(args) ||
      this.reviews.has(callId) ||
      this.reviews.size >= MAX_CORRELATIONS
    )
      return;
    this.reviews.set(callId, { toolName: "subagent" });
    return;
  }

  update(
    callId: string,
    toolName: string,
    partialResult: unknown,
  ): CorrectionAttempt | undefined {
    const correlation = this.reviews.get(callId);
    if (!correlation || toolName !== correlation.toolName) return;
    const runId = runningReviewReceipt(callId, partialResult);
    if (!runId) return;
    this.reviews.delete(callId);
    return { kind: "review", id: callId, toolName: "subagent", runId };
  }

  end(callId: string): void {
    this.reviews.delete(callId);
  }

  reset(): void {
    this.reviews.clear();
  }
}
