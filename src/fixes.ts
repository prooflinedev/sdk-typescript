import { type KnowledgeResult, McpTools } from "./mcp.js";

export interface ReverificationRequest {
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
  ): Promise<KnowledgeResult> {
    return this.call("list_open_findings", {
      repository,
      pull_request_number: pullRequestNumber,
    });
  }
  getFixContext(findingId: string): Promise<KnowledgeResult> {
    return this.call("get_fix_context", { finding_id: findingId });
  }
  requestReverification(args: ReverificationRequest): Promise<KnowledgeResult> {
    return this.call("request_reverification", args);
  }
  getReverification(requestId: string): Promise<KnowledgeResult> {
    return this.call("get_reverification", { request_id: requestId });
  }
}
