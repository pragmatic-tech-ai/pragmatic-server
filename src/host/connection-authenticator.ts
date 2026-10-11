import { AuthMethod, Credential, PresentedSecret, AuthenticatedResult } from '@pragmatic-tech-ai/todl-identity'
import type { AccessContext, Tenant } from '@pragmatic-tech-ai/todl-identity'
import { AccessContextAssembler } from '@pragmatic-tech-ai/todl-identity-node'
import type { ServerIdentityPack } from '@pragmatic-tech-ai/todl-identity-node'

/** Resolves a bearer token to an AccessContext: session first, then service token. Fail-closed:
 *  an unresolved token returns null and no context is built. */
export class ConnectionAuthenticator
{
    private static readonly EmptyReference = ''

    private readonly assembler: AccessContextAssembler

    public constructor(assembler: AccessContextAssembler = new AccessContextAssembler())
    {
        this.assembler = assembler
    }

    public async ResolveAsync(token: string, tenant: Tenant, pack: ServerIdentityPack): Promise<AccessContext | null>
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
