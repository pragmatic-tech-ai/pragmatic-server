import { AuthMethod, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import type { IAccessPolicy, IIdentityProviderPack, IdentityConfig, IdentityStoreSet, Tenant } from '@pragmatic-tech-ai/todl-identity'
import { FetchHttpClient, GoogleIdentityPack, InMemoryOidcFlowStateStore, MicrosoftEntraPack } from '@pragmatic-tech-ai/todl-identity-cloud'
import type { IHttpClient, IOidcFlowStateStore, OidcIdentityProviderPackBase, OidcPackOptions } from '@pragmatic-tech-ai/todl-identity-cloud'
import { ServerIdentityPack } from '@pragmatic-tech-ai/todl-identity-node'
import { IdentityPackKind, IdentityPackKinds } from './identity-pack-kind.js'

export interface ResolvedPack
{
    Pack: IIdentityProviderPack
    Oidc: OidcIdentityProviderPackBase | undefined
}

/** Resolves a tenant's composite identity pack from its stored IdentityConfig: the base ServerIdentityPack
 *  authenticators (service-token + local-password) plus, for an OIDC pack id, the cloud Entra/Google pack's
 *  depth-aware OIDC authenticator, at the config's delegation depth. The OIDC pack is wired over the SAME
 *  tenant store-set so group->grant writes are read back by the resource policy. */
export class IdentityPackResolver
{
    private readonly http: IHttpClient
    private readonly flowStates: IOidcFlowStateStore
    private readonly now: () => Date

    public constructor(http: IHttpClient = new FetchHttpClient(), flowStates: IOidcFlowStateStore = new InMemoryOidcFlowStateStore(), now: () => Date = () => new Date())
    {
        this.http = http
        this.flowStates = flowStates
        this.now = now
    }

    public Resolve(tenant: Tenant, config: IdentityConfig, stores: IdentityStoreSet): ResolvedPack
    {
        const kind = IdentityPackKinds.FromPackId(config.PackId)
        if (kind === IdentityPackKind.Local)
        {
            return { Pack: ServerIdentityPack.OpenWith(stores, { DelegationDepth: config.DelegationDepth }), Oidc: undefined }
        }
        const oidcPack = this.BuildOidcPack(kind, config, stores)
        const oidcAuthenticator = oidcPack.AuthenticatorFor(AuthMethod.Oidc)
        const policy: IAccessPolicy = oidcPack.Policy ?? new ResourceAuthorizationPolicy()
        const pack = ServerIdentityPack.OpenWith(stores, {
            ExtraAuthenticators: oidcAuthenticator === undefined ? [] : [oidcAuthenticator],
            DelegationDepth: config.DelegationDepth,
            Policy: policy,
        })
        return { Pack: pack, Oidc: oidcPack }
    }

    private BuildOidcPack(kind: IdentityPackKind, config: IdentityConfig, stores: IdentityStoreSet): OidcIdentityProviderPackBase
    {
        const opts: Omit<OidcPackOptions, 'Profile'> = {
            Config: config,
            Http: this.http,
            FlowStates: this.flowStates,
            Secrets: stores.Secrets,
            Sessions: stores.Sessions,
            Grants: stores.Grants,
            Audit: stores.Audit,
            now: this.now,
        }
        if (kind === IdentityPackKind.Entra)
        {
            return MicrosoftEntraPack.Create(opts)
        }
        return GoogleIdentityPack.Create(opts)
    }
}
