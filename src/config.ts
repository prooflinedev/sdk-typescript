import { type KnowledgeResult, type McpTarget, McpTools } from "./mcp.js";

/** Selects the configuration target: an environment, a repository, or the organization. */
export interface ConfigurationSelector extends McpTarget {
  environment_id?: string;
  repository?: string;
}

export interface OperationsFilter extends McpTarget {
  area?: string;
  subject?: string;
}

export interface DescribeOperationRequest extends McpTarget {
  operation: string;
  parameters?: Record<string, string>;
}

/** One file a sensitive change rests on, pinned to a full commit SHA. */
export interface CitedFile {
  repository_id: string;
  commit_sha: string;
  path: string;
}

export interface ChangeProposal extends McpTarget {
  operation: string;
  parameters?: Record<string, string>;
  input?: Record<string, unknown>;
  expected_revision?: string;
  cited_files?: CitedFile[];
  [key: string]: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function stringRecord(value: unknown, name: string): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some((item) => typeof item !== "string")
  )
    throw new TypeError(`${name} must be an object with string values`);
}

// A fresh version 7 UUID per proposal, as the CLI generates for every call.
function requestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const time = Date.now();
  for (let index = 0; index < 6; index += 1)
    bytes[index] = Math.floor(time / 2 ** (8 * (5 - index))) & 0xff;
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Hosted configuration reads and changes. Tool refusals retain isError. */
export class ConfigClient extends McpTools {
  getConfiguration(
    selector: ConfigurationSelector = {},
  ): Promise<KnowledgeResult> {
    return this.call("get_configuration", { ...selector });
  }
  listOperations(filter: OperationsFilter = {}): Promise<KnowledgeResult> {
    return this.call("list_operations", { ...filter });
  }
  describeOperation(args: DescribeOperationRequest): Promise<KnowledgeResult> {
    if (typeof args.operation !== "string" || args.operation === "")
      throw new TypeError("operation must be a nonempty string");
    if (args.parameters !== undefined)
      stringRecord(args.parameters, "parameters");
    return this.call("describe_operation", {
      operation: args.operation,
      parameters: { ...args.parameters },
      organization_id: args.organization_id,
    });
  }
  /** Proposes a change without applying it; each call carries a fresh request_id. */
  proposeChange(change: ChangeProposal): Promise<KnowledgeResult> {
    if (typeof change.operation !== "string" || change.operation === "")
      throw new TypeError("operation must be a nonempty string");
    if (change.parameters !== undefined)
      stringRecord(change.parameters, "parameters");
    if (change.cited_files !== undefined && !Array.isArray(change.cited_files))
      throw new TypeError("cited_files must be an array");
    // Snapshot the payload before validation. Protocol negotiation yields to
    // the caller, and later edits to the original objects must not change
    // what this request sends.
    const payload: ChangeProposal = { ...change };
    if (change.parameters !== undefined)
      payload.parameters = { ...change.parameters };
    if (change.input !== undefined) payload.input = { ...change.input };
    if (change.cited_files !== undefined)
      payload.cited_files = change.cited_files.map((file) =>
        file !== null && typeof file === "object" ? { ...file } : file,
      );
    for (const file of payload.cited_files ?? []) {
      if (
        file === null ||
        typeof file !== "object" ||
        typeof file.repository_id !== "string" ||
        file.repository_id === "" ||
        typeof file.path !== "string" ||
        file.path === "" ||
        typeof file.commit_sha !== "string" ||
        !COMMIT_SHA.test(file.commit_sha)
      )
        throw new TypeError(
          "cited_files entries need a nonempty repository_id, a nonempty path and a full commit SHA",
        );
    }
    return this.call("propose_change", { ...payload, request_id: requestId() });
  }
  applyChange(
    changeId: string,
    options: McpTarget = {},
  ): Promise<KnowledgeResult> {
    if (typeof changeId !== "string" || !UUID.test(changeId))
      throw new TypeError("changeId must be a UUID");
    return this.call("apply_change", {
      change_id: changeId,
      organization_id: options.organization_id,
    });
  }
}
