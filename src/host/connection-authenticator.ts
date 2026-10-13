import { AuthMethod, Credential, PresentedSecret, AuthenticatedResult } from '@pragmatic-tech-ai/todl-identity'
import type { AccessContext, Tenant } from '@pragmatic-tech-ai/todl-identity'
import { AccessContextAssembler } from '@pragmatic-tech-ai/todl-identity-node'
import type { ServerIdentityPack } from '@pragmatic-tech-ai/todl-identity-node'
import { trace, isSpanContextValid } from '@opentelemetry/api'
import { NullAccessAuditSink, AuditSurface, AuditOutcome } from './access-audit.js'
import type { IAccessAuditSink, AccessAuditEvent } from './access-audit.js'

/** Resolves a bearer token to an AccessContext: session first, then service token. Fail-closed:
 *  an unresolved token returns null and no context is built. */
export class ConnectionAuthenticator
{
    private static readonly EmptyReference = ''

    private static readonly UpgradeMethod = 'ws'

    private readonly assembler: AccessContextAssembler
    private readonly audit: IAccessAuditSink

    public constructor(assembler: AccessContextAssembler = new AccessContextAssembler(), audit: IAccessAuditSink = new NullAccessAuditSink())
    {
        this.assembler = assembler
        this.audit = audit
    }

    public async ResolveAsync(token: string, tenant: Tenant, pack: ServerIdentityPack): Promise<AccessContext | null>
    {
        const context = await this.Resolve(token, tenant, pack)
        this.Emit(tenant, context)
        return context
    }

    private Emit(tenant: Tenant, context: AccessContext | null): void
    {
        try
        {
            const spanContext = trace.getActiveSpan()?.spanContext()
            const event: AccessAuditEvent = {
                Timestamp: new Date(),
                TenantId: tenant.Id,
                PrincipalId: context?.Principal.Id,
                Surface: AuditSurface.Upgrade,
                MethodOrPath: ConnectionAuthenticator.UpgradeMethod,
                Outcome: context === null ? AuditOutcome.AuthFailure : AuditOutcome.Allow,
                CorrelationId: spanContext !== undefined && isSpanContextValid(spanContext) ? spanContext.traceId : undefined,
            }
            void this.audit.Record(event).catch(() => {})
        }
        catch
        {
            // audit is fire-and-forget: a throwing sink must never change the auth result
        }
    }

    private async Resolve(token: string, tenant: Tenant, pack: ServerIdentityPack): Promise<AccessContext | null>
    {
        if (token.length === 0)
        {
            return null
        }
        const session = await pack.Sessions.Validate(token)
        if (session !== null)
        {
            const principal = await pack.Directory.Lookup(session.PrincipalId, tenant)
            if (principal !== null)
            {
                return this.assembler.AssembleAsync(pack, tenant, principal)
            }
        }
        const serviceAuthenticator = pack.AuthenticatorFor(AuthMethod.ServiceToken)
        if (serviceAuthenticator !== undefined)
        {
            const presented = new PresentedSecret(token)
            try
            {
                const result = await serviceAuthenticator.Authenticate(new Credential(AuthMethod.ServiceToken, ConnectionAuthenticator.EmptyReference), presented, tenant)
                if (result instanceof AuthenticatedResult)
                {
                    return this.assembler.AssembleAsync(pack, tenant, result.Principal)
                }
            }
            finally
            {
                presented.Clear()
            }
        }
        return null
    }
}
