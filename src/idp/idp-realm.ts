import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AuthMethod, AuthenticatedResult, Credential, PresentedSecret, Tenant, TenantKind } from '@pragmatic-tech-ai/todl-identity';
import type { IdentityStoreSet } from '@pragmatic-tech-ai/todl-identity';
import { Argon2PasswordHasher, LocalPasswordAuthenticator } from '@pragmatic-tech-ai/todl-identity-local';
import { FileIdentityStores } from '@pragmatic-tech-ai/todl-identity-node';
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node';

/** Display-name side-store: principalId -> displayName, one small JSON doc beside the identity stores. Holds no email or secret. */
class ProfileSideStore
{
    private static readonly FileName = 'idp-profiles.json';
    private static readonly TmpSuffix = '.tmp';
    private static readonly Encoding = 'utf8';
    private static readonly NotFound = 'ENOENT';

    private readonly file: string;
    private writeQueue: Promise<void> = Promise.resolve();
    private tmpCounter = 0;

    public constructor(private readonly dir: string)
    {
        this.file = join(dir, ProfileSideStore.FileName);
    }

    public async Get(principalId: string): Promise<string | undefined>
    {
        const map = await this.Load();
        return map.get(principalId);
    }

    public Put(principalId: string, displayName: string): Promise<void>
    {
        const result = this.writeQueue.then(() => this.DoPut(principalId, displayName));
        this.writeQueue = result.catch(() => undefined);
        return result;
    }

    private async DoPut(principalId: string, displayName: string): Promise<void>
    {
        const map = await this.Load();
        map.set(principalId, displayName);
        await mkdir(this.dir, { recursive: true });
        const tmp = this.file + ProfileSideStore.TmpSuffix + (this.tmpCounter++);
        await writeFile(tmp, JSON.stringify(Object.fromEntries(map)), ProfileSideStore.Encoding);
        await rename(tmp, this.file);
    }

    private async Load(): Promise<Map<string, string>>
    {
        try
        {
            return new Map(Object.entries(JSON.parse(await readFile(this.file, ProfileSideStore.Encoding)) as Record<string, string>));
        }
        catch (e)
        {
            if ((e as NodeJS.ErrnoException).code === ProfileSideStore.NotFound)
            {
                return new Map();
            }
            throw e;
        }
    }
}

/**
 * A tenant's human-account realm for the local IdP. Reuses the todl-identity stores,
 * hasher and authenticator; keyed by the IdP's own master key (never the operator's).
 */
export class IdpRealm
{
    private static readonly SecretRefPrefix = 'idp-password/';

    private readonly hasher = new Argon2PasswordHasher();
    private readonly authenticator: LocalPasswordAuthenticator;

    private constructor(private readonly tenant: Tenant, private readonly stores: IdentityStoreSet, private readonly profiles: ProfileSideStore)
    {
        this.authenticator = new LocalPasswordAuthenticator(stores.Accounts, stores.Secrets, this.hasher);
    }

    public static async OpenFor(realmRoot: string, tenantId: string, displayName: string, masterKey: Buffer): Promise<IdpRealm>
    {
        const dir = join(realmRoot, tenantId);
        const stores = await FileIdentityStores.Open(new NodeFsStorage(dir), masterKey);
        return new IdpRealm(new Tenant(tenantId, TenantKind.SelfHosted, displayName), stores, new ProfileSideStore(dir));
    }

    public static SecretRefFor(principalId: string): string
    {
        return IdpRealm.SecretRefPrefix + principalId;
    }

    public TenantId(): string
    {
        return this.tenant.Id;
    }

    public async SeedAccount(email: string, principalId: string, password: string, displayName?: string): Promise<void>
    {
        const existing = await this.stores.Accounts.FindByPrincipalId(this.tenant, principalId);
        if (existing)
        {
            if (displayName !== undefined)
            {
                await this.profiles.Put(principalId, displayName);
            }
            return;
        }
        const ref = IdpRealm.SecretRefFor(principalId);
        await this.stores.Secrets.Put(ref, await this.hasher.Hash(password));
        await this.stores.Accounts.CreateAccount(this.tenant, email, principalId, ref);
        await this.profiles.Put(principalId, displayName ?? '');
    }

    public async LookupProfile(principalId: string): Promise<{ email: string; name: string } | null>
    {
        const account = await this.stores.Accounts.FindByPrincipalId(this.tenant, principalId);
        if (!account)
        {
            return null;
        }
        return { email: account.Email, name: (await this.profiles.Get(principalId)) ?? '' };
    }

    public async Authenticate(email: string, password: string): Promise<AuthenticatedResult | null>
    {
        const result = await this.authenticator.Authenticate(new Credential(AuthMethod.Local, email), new PresentedSecret(password), this.tenant);
        return result instanceof AuthenticatedResult ? result : null;
    }
}
