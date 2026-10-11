import { IdentityConfig, DelegationDepth, Tenant, TenantKind, IdentityProviderRegistryKey, SecretStoreKey, PasswordHasherKey } from '@pragmatic-tech-ai/todl-identity'
import { Argon2PasswordHasher } from '@pragmatic-tech-ai/todl-identity-local'
import { ConfigurableIdentityProviderRegistry } from '@pragmatic-tech-ai/todl-identity-host'
import { ServerIdentityPack, FileEncryptedSecretStore } from '@pragmatic-tech-ai/todl-identity-node'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import type { ServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import type { OidcAuthenticator } from '@pragmatic-tech-ai/todl-identity-cloud'
import { OidcAuthenticatorBuilder } from './oidc-authenticator-builder.js'
import { MasterKeyResolver } from './master-key-resolver.js'
import { ServerBootstrap } from './server-bootstrap.js'
import type { PragmaticServerIdentityOptions } from '../pragmatic-server.js'

/** Builds and registers the single-tenant identity stack: file-backed ServerIdentityPack,
 *  a SingleTenant provider registry, the secret store and password hasher. */
export class IdentityModule
{
    private static readonly PackId = 'server-pack'

    private readonly options: PragmaticServerIdentityOptions

    public constructor(options: PragmaticServerIdentityOptions)
    {
        this.options = options
    }

    public Tenant(): Tenant
    {
        return new Tenant(this.options.tenant.id, TenantKind.SelfHosted, this.options.tenant.displayName)
    }

    public async ComposeAsync(services: ServiceProvider): Promise<{ pack: ServerIdentityPack; tenant: Tenant; oidc: OidcAuthenticator | undefined }>
    {
        const tenant = this.Tenant()
        const storage = new NodeFsStorage(this.options.identityRoot)
        const masterKey = MasterKeyResolver.Resolve(this.options.masterKey)
        const hasher = new Argon2PasswordHasher()
        const oidc = this.options.oidc === undefined
            ? undefined
            : OidcAuthenticatorBuilder.Build(this.options.oidc, await FileEncryptedSecretStore.Open(storage, masterKey))
        const pack = await ServerIdentityPack.Open(storage, masterKey, oidc)
        const config = new IdentityConfig(IdentityModule.PackId, DelegationDepth.FullAuthz, new Map(), new Map(), new Map())
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
