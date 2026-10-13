import type { IHttpClient, IOidcFlowStateStore } from '@pragmatic-tech-ai/todl-identity-cloud'

/** Process-wide identity plumbing shared across tenants: one HTTP client, one flow-state store per tenant. */
export interface IdentityRuntime
{
    HttpClient: IHttpClient
    FlowStateFor(tenantId: string): IOidcFlowStateStore
}
