import { AuthMethod, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import type { IAccessPolicy, IAuthenticator, IIdentityProviderPack, IdentityConfig, IdentityStoreSet, Tenant } from '@pragmatic-tech-ai/todl-identity'
import { ClaimArrayGroupStrategy, FetchHttpClient, GenericOidcPack, GenericOidcProfile, GoogleIdentityPack, InMemoryOidcFlowStateStore, MicrosoftEntraPack, OidcSettingKeys } from '@pragmatic-tech-ai/todl-identity-cloud'
import type { IHttpClient, IOidcFlowStateStore, OidcIdentityProviderPackBase, OidcPackOptions } from '@pragmatic-tech-ai/todl-identity-cloud'
import { ServerIdentityPack } from '@pragmatic-tech-ai/todl-identity-node'
import { MachineCertAuthenticator } from '../host/machine-cert-authenticator.js'
import type { MachinePrincipalMap } from '../host/machine-principal-map.js'
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
    private static readonly GenericScopes: readonly string[] = ['openid', 'email', 'profile']
    private static readonly GenericGroupsClaim = 'groups'
    private static readonly MissingSettingError = 'OIDC provider setting is required: '

    private readonly http: IHttpClient
    private readonly flowStates: IOidcFlowStateStore
    private readonly now: () => Date

    public constructor(http: IHttpClient = new FetchHttpClient(), flowStates: IOidcFlowStateStore = new InMemoryOidcFlowStateStore(), now: () => Date = () => new Date())
    {
        this.http = http
        this.flowStates = flowStates
        this.now = now
    }

    public Resolve(tenant: Tenant, config: IdentityConfig, stores: IdentityStoreSet, machineMap?: MachinePrincipalMap): ResolvedPack
    {
        const kind = IdentityPackKinds.FromPackId(config.PackId)
        const machineAuthenticators: IAuthenticator[] = machineMap !== undefined && !machineMap.IsEmpty ? [new MachineCertAuthenticator(machineMap)] : []
        if (kind === IdentityPackKind.Local)
        {
            return { Pack: ServerIdentityPack.OpenWith(stores, { ExtraAuthenticators: machineAuthenticators, DelegationDepth: config.DelegationDepth }), Oidc: undefined }
        }
        const oidcPack = this.BuildOidcPack(kind, config, stores)
        const oidcAuthenticator = oidcPack.AuthenticatorFor(AuthMethod.Oidc)
        const policy: IAccessPolicy = oidcPack.Policy ?? new ResourceAuthorizationPolicy()
        const pack = ServerIdentityPack.OpenWith(stores, {
            ExtraAuthenticators: oidcAuthenticator === undefined ? machineAuthenticators : [oidcAuthenticator, ...machineAuthenticators],
            DelegationDepth: config.DelegationDepth,
            Policy: policy,
        })
        return { Pack: pack, Oidc: oidcPack }
    }

    private BuildOidcPack(kind: IdentityPackKind, config: IdentityConfig, stores: IdentityStoreSet): OidcIdentityProviderPackBase
    {
        if (kind === IdentityPackKind.Entra)
        {
            return MicrosoftEntraPack.Create(this.OidcOptions(config, stores))
        }
        if (kind === IdentityPackKind.GenericOidc)
        {
            const settings = config.ProviderSettings
            const profile = new GenericOidcProfile(
                IdentityPackResolver.RequireSetting(settings, OidcSettingKeys.Issuer),
                IdentityPackResolver.RequireSetting(settings, OidcSettingKeys.DiscoveryUrl),
                [...IdentityPackResolver.GenericScopes],
                config.ClaimsMapping,
                new ClaimArrayGroupStrategy(IdentityPackResolver.GenericGroupsClaim))
            return GenericOidcPack.Create({ Profile: profile, ...this.OidcOptions(config, stores) })
        }
        return GoogleIdentityPack.Create(this.OidcOptions(config, stores))
    }

    private OidcOptions(config: IdentityConfig, stores: IdentityStoreSet): Omit<OidcPackOptions, 'Profile'>
    {
        return {
            Config: config,
            Http: this.http,
            FlowStates: this.flowStates,
            Secrets: stores.Secrets,
            Sessions: stores.Sessions,
            Grants: stores.Grants,
            Audit: stores.Audit,
            now: this.now,
        }
    }

    private static RequireSetting(settings: ReadonlyMap<string, string>, key: string): string
    {
        const value = settings.get(key)
        if (value === undefined || value === '')
        {
            throw new Error(IdentityPackResolver.MissingSettingError + key)
        }
        return value
    }
}
