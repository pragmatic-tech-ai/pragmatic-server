import { join } from 'node:path';
import { AuthMethod, AuthenticatedResult, Credential, PresentedSecret, Tenant, TenantKind } from '@pragmatic-tech-ai/todl-identity';
import type { IdentityStoreSet } from '@pragmatic-tech-ai/todl-identity';
import { Argon2PasswordHasher, LocalPasswordAuthenticator } from '@pragmatic-tech-ai/todl-identity-local';
import { FileIdentityStores } from '@pragmatic-tech-ai/todl-identity-node';
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node';

/**
 * A tenant's human-account realm for the local IdP. Reuses the todl-identity stores,
 * hasher and authenticator; keyed by the IdP's own master key (never the operator's).
 */
export class IdpRealm
{
    private static readonly SecretRefPrefix = 'idp-password/';

    private readonly hasher = new Argon2PasswordHasher();
    private readonly authenticator: LocalPasswordAuthenticator;

    private constructor(private readonly tenant: Tenant, private readonly stores: IdentityStoreSet)
    {
        this.authenticator = new LocalPasswordAuthenticator(stores.Accounts, stores.Secrets, this.hasher);
    }

    public static async OpenFor(realmRoot: string, tenantId: string, displayName: string, masterKey: Buffer): Promise<IdpRealm>
    {
        const stores = await FileIdentityStores.Open(new NodeFsStorage(join(realmRoot, tenantId)), masterKey);
        return new IdpRealm(new Tenant(tenantId, TenantKind.SelfHosted, displayName), stores);
    }

    public static SecretRefFor(principalId: string): string
    {
        return IdpRealm.SecretRefPrefix + principalId;
    }

    public TenantId(): string
    {
        return this.tenant.Id;
    }

    public async SeedAccount(email: string, principalId: string, password: string): Promise<void>
    {
        const ref = IdpRealm.SecretRefFor(principalId);
        await this.stores.Secrets.Put(ref, await this.hasher.Hash(password));
        await this.stores.Accounts.CreateAccount(this.tenant, email, principalId, ref);
    }

    public async Authenticate(email: string, password: string): Promise<AuthenticatedResult | null>
    {
        const result = await this.authenticator.Authenticate(new Credential(AuthMethod.Local, email), new PresentedSecret(password), this.tenant);
        return result instanceof AuthenticatedResult ? result : null;
    }
}
