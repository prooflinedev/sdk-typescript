// Generated from the public operationIds. Regenerate with pnpm generate.
import type { components, paths } from "./schema.js";
import type { Invoke } from "./transport.js";

export type GetAgentSessionParameters = paths["/api/v1/organizations/{org_id}/agent-sessions/{session_id}"]["get"]["parameters"];
export type GetFindingParameters = paths["/api/v1/organizations/{org_id}/findings/{finding_id}"]["get"]["parameters"];
export type GetAgentSessionPromptParameters = paths["/api/v1/organizations/{org_id}/findings/{finding_id}/agent-session-prompt"]["get"]["parameters"];
export type StartAgentSessionParameters = paths["/api/v1/organizations/{org_id}/findings/{finding_id}/agent-sessions"]["post"]["parameters"];
export type StartAgentSessionBody = NonNullable<paths["/api/v1/organizations/{org_id}/findings/{finding_id}/agent-sessions"]["post"]["requestBody"]>["content"]["application/json"];
export type GetFindingFixPromptParameters = paths["/api/v1/organizations/{org_id}/findings/{finding_id}/fix-prompt"]["get"]["parameters"];
export type RequestCommitReviewParameters = paths["/api/v1/organizations/{org_id}/repositories/{repo_id}/commit-reviews"]["post"]["parameters"];
export type RequestCommitReviewBody = NonNullable<paths["/api/v1/organizations/{org_id}/repositories/{repo_id}/commit-reviews"]["post"]["requestBody"]>["content"]["application/json"];
export type RequestPatchReviewParameters = paths["/api/v1/organizations/{org_id}/repositories/{repo_id}/patch-reviews"]["post"]["parameters"];
export type RequestPatchReviewBody = NonNullable<paths["/api/v1/organizations/{org_id}/repositories/{repo_id}/patch-reviews"]["post"]["requestBody"]>["content"]["application/json"];
export type RequestReviewParameters = paths["/api/v1/organizations/{org_id}/repositories/{repo_id}/pull-requests/{number}/review"]["post"]["parameters"];
export type RequestReviewBody = NonNullable<paths["/api/v1/organizations/{org_id}/repositories/{repo_id}/pull-requests/{number}/review"]["post"]["requestBody"]>["content"]["application/json"];
export type GetReviewGuidanceParameters = paths["/api/v1/organizations/{org_id}/repositories/{repo_id}/review-guidance"]["get"]["parameters"];
export type ListRepositoriesParameters = paths["/api/v1/organizations/{org_id}/repository-names"]["get"]["parameters"];
export type ListReviewsParameters = paths["/api/v1/organizations/{org_id}/reviews"]["get"]["parameters"];
export type GetDeploymentReviewParameters = paths["/api/v1/organizations/{org_id}/reviews/deployments/{public_key}"]["get"]["parameters"];
export type ListPullRequestReviewsParameters = paths["/api/v1/organizations/{org_id}/reviews/pr/{repository}/{pull_request_number}"]["get"]["parameters"];
export type GetPullRequestReviewParameters = paths["/api/v1/organizations/{org_id}/reviews/pr/{repository}/{pull_request_number}/runs/{run_number}"]["get"]["parameters"];
export type GetReviewParameters = paths["/api/v1/organizations/{org_id}/reviews/{review_id}"]["get"]["parameters"];
export type GetAssessmentParameters = paths["/api/v1/organizations/{org_id}/reviews/{review_id}/assessments/{assessment_id}"]["get"]["parameters"];
export type RerunReviewParameters = paths["/api/v1/organizations/{org_id}/reviews/{review_id}/rerun"]["post"]["parameters"];
export type GetReviewRoutingParameters = paths["/api/v1/organizations/{org_id}/reviews/{review_id}/routing"]["get"]["parameters"];

export class Operations {
  constructor(private readonly invoke: Invoke) {}

  getAgentSession(parameters: GetAgentSessionParameters): Promise<components["schemas"]["AgentSession"]> {
    return this.invoke("GET", "/api/v1/organizations/{org_id}/agent-sessions/{session_id}", parameters);
  }

  getFinding(parameters: GetFindingParameters): Promise<components["schemas"]["CustomerFinding"]> {
    return this.invoke("GET", "/api/v1/organizations/{org_id}/findings/{finding_id}", parameters);
  }

  getAgentSessionPrompt(parameters: GetAgentSessionPromptParameters): Promise<components["schemas"]["AgentSessionPrompt"]> {
    return this.invoke("GET", "/api/v1/organizations/{org_id}/findings/{finding_id}/agent-session-prompt", parameters);
  }

  startAgentSession(parameters: StartAgentSessionParameters, body: StartAgentSessionBody): Promise<components["schemas"]["AgentSession"]> {
    return this.invoke("POST", "/api/v1/organizations/{org_id}/findings/{finding_id}/agent-sessions", parameters, body);
  }

  getFindingFixPrompt(parameters: GetFindingFixPromptParameters): Promise<components["schemas"]["FindingFixPrompt"]> {
    return this.invoke("GET", "/api/v1/organizations/{org_id}/findings/{finding_id}/fix-prompt", parameters);
  }

  requestCommitReview(parameters: RequestCommitReviewParameters, body: RequestCommitReviewBody): Promise<components["schemas"]["CommitReviewResponse"]> {
    return this.invoke("POST", "/api/v1/organizations/{org_id}/repositories/{repo_id}/commit-reviews", parameters, body);
  }

  requestPatchReview(parameters: RequestPatchReviewParameters, body: RequestPatchReviewBody): Promise<components["schemas"]["PatchReviewResponse"]> {
    return this.invoke("POST", "/api/v1/organizations/{org_id}/repositories/{repo_id}/patch-reviews", parameters, body);
  }

  requestReview(parameters: RequestReviewParameters, body?: RequestReviewBody): Promise<components["schemas"]["RunNowResponse"]> {
    return this.invoke("POST", "/api/v1/organizations/{org_id}/repositories/{repo_id}/pull-requests/{number}/review", parameters, body);
  }

  getReviewGuidance(parameters: GetReviewGuidanceParameters): Promise<components["schemas"]["RepositoryGuidance"]> {
    return this.invoke("GET", "/api/v1/organizations/{org_id}/repositories/{repo_id}/review-guidance", parameters);
  }

  listRepositories(parameters: ListRepositoriesParameters): Promise<components["schemas"]["RepositoryNames"]> {
    return this.invoke("GET", "/api/v1/organizations/{org_id}/repository-names", parameters);
  }

  listReviews(parameters: ListReviewsParameters): Promise<components["schemas"]["ReviewPage"]> {
    return this.invoke("GET", "/api/v1/organizations/{org_id}/reviews", parameters);
  }

  getDeploymentReview(parameters: GetDeploymentReviewParameters): Promise<components["schemas"]["CustomerReviewDetail"]> {
    return this.invoke("GET", "/api/v1/organizations/{org_id}/reviews/deployments/{public_key}", parameters);
  }

  listPullRequestReviews(parameters: ListPullRequestReviewsParameters): Promise<components["schemas"]["ReviewPage"]> {
    return this.invoke("GET", "/api/v1/organizations/{org_id}/reviews/pr/{repository}/{pull_request_number}", parameters);
  }

  getPullRequestReview(parameters: GetPullRequestReviewParameters): Promise<components["schemas"]["CustomerReviewDetail"]> {
    return this.invoke("GET", "/api/v1/organizations/{org_id}/reviews/pr/{repository}/{pull_request_number}/runs/{run_number}", parameters);
  }

  getReview(parameters: GetReviewParameters): Promise<components["schemas"]["CustomerReviewDetail"]> {
    return this.invoke("GET", "/api/v1/organizations/{org_id}/reviews/{review_id}", parameters);
  }

  getAssessment(parameters: GetAssessmentParameters): Promise<components["schemas"]["CustomerAssessmentDetail"]> {
    return this.invoke("GET", "/api/v1/organizations/{org_id}/reviews/{review_id}/assessments/{assessment_id}", parameters);
  }

  rerunReview(parameters: RerunReviewParameters): Promise<components["schemas"]["RerunResponse"]> {
    return this.invoke("POST", "/api/v1/organizations/{org_id}/reviews/{review_id}/rerun", parameters);
  }

  getReviewRouting(parameters: GetReviewRoutingParameters): Promise<components["schemas"]["ReviewRoutingView"]> {
    return this.invoke("GET", "/api/v1/organizations/{org_id}/reviews/{review_id}/routing", parameters);
  }
}
