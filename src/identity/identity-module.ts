import { IdentityConfig, DelegationDepth, Tenant, TenantKind, IdentityProviderRegistryKey, SecretStoreKey, PasswordHasherKey, TenantConfigStoreKey } from '@pragmatic-tech-ai/todl-identity'
import { Argon2PasswordHasher } from '@pragmatic-tech-ai/todl-identity-local'
import { ConfigurableIdentityProviderRegistry } from '@pragmatic-tech-ai/todl-identity-host'
import { ServerIdentityPack } from '@pragmatic-tech-ai/todl-identity-node'
import type { ServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import { FetchHttpClient, InMemoryOidcFlowStateStore, OidcSettingKeys } from '@pragmatic-tech-ai/todl-identity-cloud'
import type { OidcIdentityProviderPackBase } from '@pragmatic-tech-ai/todl-identity-cloud'
import { IdentityPackResolver } from './identity-pack-resolver.js'
import { ServerBootstrap } from './server-bootstrap.js'
import { TenantSecretProvisioner } from './tenant-secret-provisioner.js'
import type { PragmaticServerIdentityOptions, OidcServerOptions } from '../pragmatic-server.js'
import type { PlatformServices } from '../platform/platform-services.js'

/** Builds and registers the single-tenant identity stack from the platform bundle: the ServerIdentityPack
 *  (over the platform's identity stores), a SingleTenant provider registry, the secret store and password hasher. */
export class IdentityModule
{
    private static readonly LocalPackId = 'local'
    private static readonly GenericOidcPackId = 'generic-oidc'

    private readonly options: PragmaticServerIdentityOptions
    private readonly platform: PlatformServices

    public constructor(options: PragmaticServerIdentityOptions, platform: PlatformServices)
    {
        this.options = options
        this.platform = platform
    }

    public Tenant(): Tenant
    {
        return new Tenant(this.options.tenant.id, TenantKind.SelfHosted, this.options.tenant.displayName)
    }

    public async ComposeAsync(services: ServiceProvider): Promise<{ pack: ServerIdentityPack; tenant: Tenant; oidc: OidcIdentityProviderPackBase | undefined }>
    {
        const tenant = this.Tenant()
        const masterKey = this.platform.ResolveMasterKey(this.options.masterKey)
        const hasher = new Argon2PasswordHasher()
        const stores = await this.platform.CreateIdentityStores(this.options.identityRoot, masterKey)
        const tenantConfig = await this.platform.CreateTenantConfigStore(this.options.identityRoot)
        const seed = this.options.identityConfig ?? IdentityModule.LegacyOrLocal(this.options.oidc)
        const stored = await tenantConfig.Get(tenant.Id)
        const config = stored ?? seed
        if (stored === null)
        {
            await tenantConfig.Save(tenant.Id, seed)
        }
        if (this.options.provisionedSecrets !== undefined)
        {
            const refs: string[] = []
            const oidcSecretRef = config.ProviderSettings.get(OidcSettingKeys.SecretRef)
            if (oidcSecretRef !== undefined && oidcSecretRef !== '')
            {
                refs.push(oidcSecretRef)
            }
            if (this.options.bootstrap !== undefined)
            {
                refs.push(this.options.bootstrap.adminPasswordRef)
            }
            if (this.options.additionalSecretRefs !== undefined)
            {
                refs.push(...this.options.additionalSecretRefs)
            }
            const unique = [...new Set(refs)]
            await new TenantSecretProvisioner(this.options.provisionedSecrets).EnsureAsync(stores.Secrets, unique)
        }
        const resolver = new IdentityPackResolver(this.options.httpClient ?? new FetchHttpClient(), this.options.flowStateStore ?? new InMemoryOidcFlowStateStore())
        const resolved = resolver.Resolve(tenant, config, stores, this.options.machine)
        const pack = resolved.Pack
        services.registerInstance(TenantConfigStoreKey, tenantConfig)
        const registry = await ConfigurableIdentityProviderRegistry.SingleTenant(tenant, config, pack)
        services.registerInstance(IdentityProviderRegistryKey, registry)
        services.registerInstance(SecretStoreKey, pack.Secrets)
        services.registerInstance(PasswordHasherKey, hasher)
        if (this.options.bootstrap !== undefined)
        {
            await ServerBootstrap.SeedAsync(pack, tenant, this.options.bootstrap)
        }
        return { pack, tenant, oidc: resolved.Oidc }
    }

    /** A tenant given only the legacy flat oidc options gets the equivalent generic-oidc config; none means local-only. */
    private static LegacyOrLocal(oidc: OidcServerOptions | undefined): IdentityConfig
    {
        if (oidc === undefined)
        {
            return new IdentityConfig(IdentityModule.LocalPackId, DelegationDepth.FullAuthz, new Map(), new Map(), new Map())
        }
        const settings = new Map<string, string>([
            [OidcSettingKeys.Issuer, oidc.issuer],
            [OidcSettingKeys.DiscoveryUrl, oidc.discoveryUrl],
            [OidcSettingKeys.ClientId, oidc.clientId],
            [OidcSettingKeys.RedirectUri, oidc.redirectUri],
            [OidcSettingKeys.SecretRef, oidc.clientSecretRef],
        ])
        return new IdentityConfig(IdentityModule.GenericOidcPackId, DelegationDepth.AuthnDirectory, settings, new Map(), new Map())
    }
}
