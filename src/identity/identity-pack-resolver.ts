import { AuthMethod, ResourceAuthorizationPolicy, type IAccessPolicy, type IAuthenticator, type IdentityConfig, type IdentityStoreSet, type Realm } from '@pragmatic-tech-ai/pragmatic-identity'
import { ClaimArrayGroupStrategy, FetchHttpClient, GenericOidcPack, GenericOidcProfile, InMemoryOidcFlowStateStore, OidcSettingKeys, type IHttpClient, type IOidcFlowStateStore, type OidcIdentityProviderPackBase, type OidcPackOptions } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { MicrosoftEntraPack } from '@pragmatic-tech-ai/pragmatic-identity-source-entra'
import { GoogleIdentityPack } from '@pragmatic-tech-ai/pragmatic-identity-source-google'
import { ServerIdentityPack } from '@pragmatic-tech-ai/pragmatic-identity-store'
import { MachineCertAuthenticator } from '../host/machine-cert-authenticator.js'
import type { MachinePrincipalMap } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { IdentityPackKind, IdentityPackKinds } from './identity-pack-kind.js'

export interface ResolvedPack
{
    Pack: ServerIdentityPack
    Oidc: OidcIdentityProviderPackBase | undefined
}

/** Resolves a realm's composite identity pack from its stored IdentityConfig: the base ServerIdentityPack
 *  authenticators (service-token + local-password) plus, for an OIDC pack id, the cloud Entra/Google pack's
 *  depth-aware OIDC authenticator, at the config's delegation depth (and Entra's on-behalf-of source tokens). The
 *  OIDC pack is wired over the SAME realm store-set so group->grant writes are read back by the resource policy. */
export class IdentityPackResolver
{
    private static readonly GenericScopes: readonly string[] = ['openid', 'email', 'profile']
    private static readonly GenericGroupsClaim = 'groups'
    private static readonly UnexpectedKindError = 'unexpected identity pack kind: '
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

    public Resolve(realm: Realm, config: IdentityConfig, stores: IdentityStoreSet, machineMap?: MachinePrincipalMap): ResolvedPack
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
            // per-user source tokens (PR12): Entra's on-behalf-of provider; other packs keep the local default
            SourceTokens: oidcPack instanceof MicrosoftEntraPack ? oidcPack.SourceTokens : undefined,
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
        if (kind === IdentityPackKind.Google)
        {
            return GoogleIdentityPack.Create(this.OidcOptions(config, stores))
        }
        throw new Error(IdentityPackResolver.UnexpectedKindError + IdentityPackKind[kind])
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
