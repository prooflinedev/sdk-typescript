import { type KnowledgeResult, type McpTarget, McpTools } from "./mcp.js";

export interface SetupCandidatesQuery extends McpTarget {
  /** Keeps the candidates whose name matches, 1 to 100 characters. */
  query?: string;
}

/** Hosted setup reads. Tool refusals retain isError. */
export class SetupClient extends McpTools {
  getStatus(options: McpTarget = {}): Promise<KnowledgeResult> {
    return this.call("get_setup_status", {
      organization_id: options.organization_id,
    });
  }
  listCandidates(args: SetupCandidatesQuery = {}): Promise<KnowledgeResult> {
    if (args.query !== undefined) {
      if (typeof args.query !== "string")
        throw new TypeError("query must be a string");
      const length = Array.from(args.query).length;
      if (length < 1 || length > 100)
        throw new TypeError("query must be 1 to 100 characters");
    }
    return this.call("list_setup_candidates", {
      query: args.query,
      organization_id: args.organization_id,
    });
  }
}
