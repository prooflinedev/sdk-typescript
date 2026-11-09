import { type KnowledgeResult, type McpTarget, McpTools } from "./mcp.js";

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
  getArchitectureDocument(
    environmentId: string,
    options: McpTarget = {},
  ): Promise<KnowledgeResult> {
    return this.call("get_architecture_document", {
      environment_id: environmentId,
      organization_id: options.organization_id,
    });
  }
  getPlan(planId: string, options: McpTarget = {}): Promise<KnowledgeResult> {
    return this.call("get_plan", {
      plan_id: planId,
      organization_id: options.organization_id,
    });
  }
  startPlanImplementation(
    planId: string,
    options: McpTarget = {},
  ): Promise<KnowledgeResult> {
    return this.call("start_plan_implementation", {
      plan_id: planId,
      organization_id: options.organization_id,
    });
  }
  getPlanImplementation(
    implementationId: string,
    options: McpTarget = {},
  ): Promise<KnowledgeResult> {
    return this.call("get_plan_implementation", {
      implementation_id: implementationId,
      organization_id: options.organization_id,
    });
  }
}
