import {
  ProoflineError,
  type StreamResponseDecoder,
  type Transport,
} from "./transport.js";

/** Strings in tool results remain untrusted; structuredContent is server-owned JSON. */
export interface KnowledgeResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
/** Selects one authorized organization for this call only. */
export interface McpTarget {
  organization_id?: string;
}
export interface RepositoryKnowledge extends McpTarget {
  repository: string;
  commit?: string;
}
const PROTOCOL = "2025-11-25";
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function refused(): ProoflineError {
  return new ProoflineError(
    0,
    "urn:proofline:sdk:mcp",
    "Invalid or refused MCP response",
  );
}
function unsupportedServerRequest(): ProoflineError {
  return new ProoflineError(
    0,
    "urn:proofline:sdk:mcp",
    "This SDK cannot handle MCP server-initiated requests; use an MCP client that supports server request handlers.",
  );
}
function envelope(value: unknown, id: number): Record<string, unknown> {
  if (
    !object(value) ||
    value.jsonrpc !== "2.0" ||
    value.id !== id ||
    "error" in value ||
    !object(value.result)
  )
    throw refused();
  return value.result;
}

class McpEventStreamDecoder implements StreamResponseDecoder {
  readonly #id: number;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #buffer = "";
  #data: string[] = [];

  constructor(id: number) {
    this.#id = id;
  }

  push(chunk: Uint8Array):
    | { complete: false }
    | { complete: true; value: unknown } {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    return this.#consume();
  }

  finish(): unknown {
    this.#buffer += this.#decoder.decode();
    const result = this.#consume(true);
    if (result.complete) return result.value;
    throw refused();
  }

  #consume(final = false):
    | { complete: false }
    | { complete: true; value: unknown } {
    let start = 0;
    for (let index = 0; index < this.#buffer.length; index += 1) {
      const char = this.#buffer[index];
      if (char !== "\r" && char !== "\n") continue;
      if (char === "\r" && index + 1 === this.#buffer.length && !final) break;
      const line = this.#buffer.slice(start, index);
      start =
        index + (char === "\r" && this.#buffer[index + 1] === "\n" ? 2 : 1);
      index = start - 1;
      const result = this.#line(line);
      if (result) {
        this.#buffer = this.#buffer.slice(start);
        return result;
      }
    }
    this.#buffer = this.#buffer.slice(start);
    if (final && this.#buffer) this.#line(this.#buffer);
    return { complete: false };
  }

  #line(line: string): { complete: true; value: unknown } | undefined {
    if (line === "") {
      if (!this.#data.length) return undefined;
      const payload = this.#data.join("\n");
      this.#data = [];
      if (!payload) return undefined;
      let message: unknown;
      try {
        message = JSON.parse(payload) as unknown;
      } catch {
        throw refused();
      }
      if (!object(message) || message.jsonrpc !== "2.0") throw refused();
      if (typeof message.method === "string") {
        if ("id" in message) throw unsupportedServerRequest();
        return undefined;
      }
      if (message.id !== this.#id) throw refused();
      return { complete: true, value: message };
    }
    if (line.startsWith(":")) return undefined;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    if (field !== "data") return undefined;
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    this.#data.push(value);
    return undefined;
  }
}

/** Typed knowledge operations over Proofline's stateless MCP endpoint. Calls never retry. */
export class McpTools {
  constructor(private readonly transport: Transport) {}

  protected async call(name: string, args: object): Promise<KnowledgeResult> {
    // Bind the per-call target before protocol negotiation yields to the caller.
    const callArguments = { ...args };
    const invoke = (
      body: object,
      phase: "initialize" | "notification" | "call",
      id?: number,
    ) =>
      this.transport.request<unknown>(
        "POST",
        "/mcp",
        {},
        undefined,
        body,
        (text) => {
          if (phase === "notification") {
            if (text !== "") throw refused();
            return undefined;
          }
          return JSON.parse(text) as unknown;
        },
        "application/json, text/event-stream",
        phase,
        phase === "notification" || id === undefined
          ? undefined
          : () => new McpEventStreamDecoder(id),
      );
    const initialized = envelope(
      await invoke(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL,
            capabilities: {},
            clientInfo: { name: "proofline-typescript", version: "1" },
          },
        },
        "initialize",
        1,
      ),
      1,
    );
    if (initialized.protocolVersion !== PROTOCOL) throw refused();
    await invoke(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      "notification",
    );
    const result = envelope(
      await invoke(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name, arguments: callArguments },
        },
        "call",
        2,
      ),
      2,
    );
    if (
      !Array.isArray(result.content) ||
      result.content.some(
        (item: unknown) =>
          !object(item) ||
          item.type !== "text" ||
          typeof item.text !== "string",
      ) ||
      (result.isError !== undefined && typeof result.isError !== "boolean") ||
      (result.structuredContent !== undefined &&
        !object(result.structuredContent))
    )
      throw refused();
    return result as unknown as KnowledgeResult;
  }
}

/** Discover the organizations currently authorized for this MCP credential. */
export class McpClient extends McpTools {
  listOrganizations(): Promise<KnowledgeResult> {
    return this.call("list_organizations", {});
  }
}
