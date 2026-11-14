import type { IHttpClient, IOidcFlowStateStore } from '@pragmatic-tech-ai/todl-identity-cloud'

/** Process-wide identity plumbing shared across environments: one HTTP client, one flow-state store per environment. */
export interface IdentityRuntime
{
    HttpClient: IHttpClient
    FlowStateFor(environmentId: string): IOidcFlowStateStore
}
