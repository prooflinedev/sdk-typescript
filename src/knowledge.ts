import { ProoflineError, type Transport } from "./transport.js";

/** Strings in tool results remain untrusted; structuredContent is server-owned JSON. */
export interface KnowledgeResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
export interface RepositoryKnowledge {
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

/** Typed knowledge operations over Proofline's stateless MCP endpoint. Calls never retry. */
export class KnowledgeClient {
  constructor(private readonly transport: Transport) {}

  listWikiPages(args: RepositoryKnowledge): Promise<KnowledgeResult> {
    return this.call("list_wiki_pages", args);
  }
  getWikiPage(
    args: RepositoryKnowledge & { page_key: string },
  ): Promise<KnowledgeResult> {
    return this.call("get_wiki_page", args);
  }
  askCodebase(
    args: RepositoryKnowledge & { question: string },
  ): Promise<KnowledgeResult> {
    return this.call("ask_codebase", args);
  }
  getArchitectureDocument(environmentId: string): Promise<KnowledgeResult> {
    return this.call("get_architecture_document", {
      environment_id: environmentId,
    });
  }
  getPlan(planId: string): Promise<KnowledgeResult> {
    return this.call("get_plan", { plan_id: planId });
  }
  startPlanImplementation(planId: string): Promise<KnowledgeResult> {
    return this.call("start_plan_implementation", { plan_id: planId });
  }
  getPlanImplementation(implementationId: string): Promise<KnowledgeResult> {
    return this.call("get_plan_implementation", {
      implementation_id: implementationId,
    });
  }

  private async call(name: string, args: object): Promise<KnowledgeResult> {
    const invoke = (
      body: object,
      phase: "initialize" | "notification" | "call",
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
          params: { name, arguments: args },
        },
        "call",
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
