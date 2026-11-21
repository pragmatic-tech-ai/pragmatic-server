import { AuthMethod, Credential, PresentedSecret, AuthenticatedResult, SystemPrincipal, type AccessContext, type Realm, ScopedAccessContext } from '@pragmatic-tech-ai/pragmatic-identity'
import { AccessContextAssembler, type ServerIdentityPack } from '@pragmatic-tech-ai/pragmatic-identity-store'
import { trace, isSpanContextValid } from '@opentelemetry/api'
import { NullAccessAuditSink, AuditSurface, AuditOutcome, type IAccessAuditSink, type AccessAuditEvent } from '@pragmatic-tech-ai/pragmatic-env-cluster'

/** Resolves a bearer token to an AccessContext: session first, then service token. Fail-closed:
 *  an unresolved token returns null and no context is built. A principal in the reserved system namespace
 *  (`SystemPrincipal.IsReserved`: the environment's system id and every other `system:` id) is refused like an unknown
 *  credential: a User with that id would own the system principal's records at User depth. */
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

    public async ResolveAsync(token: string, realm: Realm, pack: ServerIdentityPack): Promise<AccessContext | null>
    {
        const resolved = await this.Resolve(token, realm, pack)
        const context = resolved !== null && SystemPrincipal.IsReserved(resolved.Principal.Id) ? null : resolved
        this.Emit(realm, context)
        return context
    }

    private Emit(realm: Realm, context: AccessContext | null): void
    {
        try
        {
            const spanContext = trace.getActiveSpan()?.spanContext()
            const event: AccessAuditEvent = {
                Timestamp: new Date(),
                EnvironmentId: realm.Id,
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

    private async Resolve(token: string, realm: Realm, pack: ServerIdentityPack): Promise<AccessContext | null>
    {
        if (token.length === 0)
        {
            return null
        }
        const session = await pack.Sessions.Validate(token)
        if (session !== null)
        {
            const principal = await pack.Directory.Lookup(session.PrincipalId, realm)
            if (principal !== null)
            {
                return this.assembler.AssembleAsync(pack, realm, principal)
            }
        }
        const serviceAuthenticator = pack.AuthenticatorFor(AuthMethod.ServiceToken)
        if (serviceAuthenticator !== undefined)
        {
            const presented = new PresentedSecret(token)
            try
            {
                const result = await serviceAuthenticator.Authenticate(new Credential(AuthMethod.ServiceToken, ConnectionAuthenticator.EmptyReference), presented, realm)
                if (result instanceof AuthenticatedResult)
                {
                    // a service token's scopes ride in Principal.Groups; carry them explicitly so only this path is ever scope-restricted
                    const context = await this.assembler.AssembleAsync(pack, realm, result.Principal)
                    return new ScopedAccessContext(context, result.Principal.Groups)
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
