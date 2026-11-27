import { type KnowledgeResult, type McpTarget, McpTools } from "./mcp.js";

export interface SetupCandidatesQuery extends McpTarget {
  /** Keeps the candidates whose name matches, 1 to 100 Unicode code points. */
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
    // Read the query once: a getter must not supply a different value to
    // validation and to the request.
    const query = args.query;
    if (query !== undefined) {
      if (typeof query !== "string")
        throw new TypeError("query must be a string");
      // Count code points without materializing them; stop at the first excess
      // so an oversized query never scans or allocates beyond the limit.
      const codePoints = query[Symbol.iterator]();
      let length = 0;
      while (length <= 100 && !codePoints.next().done) length += 1;
      if (length < 1 || length > 100)
        throw new TypeError("query must be 1 to 100 Unicode code points");
    }
    return this.call("list_setup_candidates", {
      query,
      organization_id: args.organization_id,
    });
  }
}
