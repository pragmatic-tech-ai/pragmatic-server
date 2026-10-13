import type { Action, ResourceKind } from '@pragmatic-tech-ai/todl-identity'

/** The surface a decision was made on. */
export enum AuditSurface
{
    Rpc = 'rpc',
    Http = 'http',
    Upgrade = 'upgrade',
}

/** The outcome recorded for one decision. */
export enum AuditOutcome
{
    Allow = 'allow',
    Deny = 'deny',
    AuthFailure = 'auth-failure',
    RateLimited = 'rate-limited',
}

/** One security-audit record. Every field is an identifier, a classification, or an outcome — never a
 *  secret/token/credential/fingerprint. Action/ResourceKind are absent for auth and untabled events. */
export interface AccessAuditEvent
{
    Timestamp: Date
    TenantId: string
    PrincipalId?: string
    Surface: AuditSurface
    MethodOrPath: string
    Action?: Action
    ResourceKind?: ResourceKind
    ResourcePath?: string
    Outcome: AuditOutcome
    Reason?: string
    CorrelationId?: string
}

/** Server-declared audit seam: fire-and-forget after a decision stands; implementations must never throw into
 *  a request and never alter the decision. */
export interface IAccessAuditSink
{
    Record(event: AccessAuditEvent): Promise<void>
}

/** Default sink: records nothing, so composing without an audit sink is byte-safe. */
export class NullAccessAuditSink implements IAccessAuditSink
{
    public Record(): Promise<void>
    {
        return Promise.resolve()
    }
}
