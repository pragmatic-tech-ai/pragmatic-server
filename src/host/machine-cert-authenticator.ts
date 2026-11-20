import { AuthMethod, AuthenticatedResult, Principal, PrincipalKind, RejectedResult } from '@pragmatic-tech-ai/pragmatic-identity'
import type { AuthenticationResult, Credential, IAuthenticator, PresentedSecret, Realm } from '@pragmatic-tech-ai/pragmatic-identity'
import type { MachinePrincipalMap } from './machine-principal-map.js'

/** Authenticates a machine by its (already TLS-verified) client-cert fingerprint, carried in Credential.Reference. */
export class MachineCertAuthenticator implements IAuthenticator
{
    private static readonly RejectReason = 'machine certificate is not mapped to a principal'

    public readonly Method = AuthMethod.Machine

    private readonly map: MachinePrincipalMap

    public constructor(map: MachinePrincipalMap)
    {
        this.map = map
    }

    public async Authenticate(credential: Credential, _presented: PresentedSecret, realm: Realm): Promise<AuthenticationResult>
    {
        if (credential.Reference.length === 0)
        {
            return new RejectedResult(MachineCertAuthenticator.RejectReason)
        }
        const entry = this.map.Lookup(credential.Reference)
        if (entry === undefined)
        {
            return new RejectedResult(MachineCertAuthenticator.RejectReason)
        }
        return new AuthenticatedResult(new Principal(entry.PrincipalId, realm.Id, PrincipalKind.Machine, new Map(), [...entry.Groups]))
    }
}
