import { type KnowledgeResult, type McpTarget, McpTools } from "./mcp.js";

export interface ReverificationRequest extends McpTarget {
  review_id: string;
  finding_ids: string[];
  commit_sha: string;
  note?: string;
}

/** Fix context and pushed-head verification. Tool refusals retain isError. */
export class FixesClient extends McpTools {
  listOpenFindings(
    repository: string,
    pullRequestNumber: number,
    options: McpTarget = {},
  ): Promise<KnowledgeResult> {
    return this.call("list_open_findings", {
      repository,
      pull_request_number: pullRequestNumber,
      organization_id: options.organization_id,
    });
  }
  getFixContext(
    findingId: string,
    options: McpTarget = {},
  ): Promise<KnowledgeResult> {
    return this.call("get_fix_context", {
      finding_id: findingId,
      organization_id: options.organization_id,
    });
  }
  requestReverification(args: ReverificationRequest): Promise<KnowledgeResult> {
    return this.call("request_reverification", args);
  }
  getReverification(
    requestId: string,
    options: McpTarget = {},
  ): Promise<KnowledgeResult> {
    return this.call("get_reverification", {
      request_id: requestId,
      organization_id: options.organization_id,
    });
  }
}
