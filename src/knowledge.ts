import { type KnowledgeResult, McpTools } from "./mcp.js";

export type { KnowledgeResult, RepositoryKnowledge } from "./mcp.js";

import type { RepositoryKnowledge } from "./mcp.js";

/** Published knowledge operations through the scoped MCP server. */
export class KnowledgeClient extends McpTools {
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
}
