import { IdentityConfig, DelegationDepth, Tenant, TenantKind, IdentityProviderRegistryKey, SecretStoreKey, PasswordHasherKey, TenantConfigStoreKey } from '@pragmatic-tech-ai/todl-identity'
import { Argon2PasswordHasher } from '@pragmatic-tech-ai/todl-identity-local'
import { ConfigurableIdentityProviderRegistry } from '@pragmatic-tech-ai/todl-identity-host'
import { ServerIdentityPack } from '@pragmatic-tech-ai/todl-identity-node'
import type { ServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import type { OidcAuthenticator } from '@pragmatic-tech-ai/todl-identity-cloud'
import { OidcAuthenticatorBuilder } from './oidc-authenticator-builder.js'
import { ServerBootstrap } from './server-bootstrap.js'
import { TenantSecretProvisioner } from './tenant-secret-provisioner.js'
import type { PragmaticServerIdentityOptions } from '../pragmatic-server.js'
import type { PlatformServices } from '../platform/platform-services.js'

/** Builds and registers the single-tenant identity stack from the platform bundle: the ServerIdentityPack
 *  (over the platform's identity stores), a SingleTenant provider registry, the secret store and password hasher. */
export class IdentityModule
{
    private static readonly PackId = 'server-pack'

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

    public async ComposeAsync(services: ServiceProvider): Promise<{ pack: ServerIdentityPack; tenant: Tenant; oidc: OidcAuthenticator | undefined }>
    {
        const tenant = this.Tenant()
        const masterKey = this.platform.ResolveMasterKey(this.options.masterKey)
        const hasher = new Argon2PasswordHasher()
        const stores = await this.platform.CreateIdentityStores(this.options.identityRoot, masterKey)
        if (this.options.provisionedSecrets !== undefined)
        {
            const refs: string[] = []
            if (this.options.oidc !== undefined)
            {
                refs.push(this.options.oidc.clientSecretRef)
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
        const oidc = this.options.oidc === undefined
            ? undefined
            : OidcAuthenticatorBuilder.Build(this.options.oidc, stores.Secrets)
        const pack = ServerIdentityPack.OpenWith(stores, oidc)
        const config = new IdentityConfig(IdentityModule.PackId, DelegationDepth.FullAuthz, new Map(), new Map(), new Map())
        const tenantConfig = await this.platform.CreateTenantConfigStore(this.options.identityRoot)
        await tenantConfig.Save(tenant.Id, config)
        services.registerInstance(TenantConfigStoreKey, tenantConfig)
        const registry = await ConfigurableIdentityProviderRegistry.SingleTenant(tenant, config, pack)
        services.registerInstance(IdentityProviderRegistryKey, registry)
        services.registerInstance(SecretStoreKey, pack.Secrets)
        services.registerInstance(PasswordHasherKey, hasher)
        if (this.options.bootstrap !== undefined)
        {
            await ServerBootstrap.SeedAsync(pack, tenant, this.options.bootstrap)
        }
        return { pack, tenant, oidc }
    }
}
