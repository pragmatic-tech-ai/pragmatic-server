import { AuthMethod, AuthenticatedResult, Credential, PresentedSecret, Realm, RealmKind } from '@pragmatic-tech-ai/pragmatic-identity';
import type { ISecretStore } from '@pragmatic-tech-ai/pragmatic-identity';
import { Argon2PasswordHasher, LocalPasswordAuthenticator } from '@pragmatic-tech-ai/pragmatic-identity-source-local';
import type { IHttpClient } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc';
import type { TenantIdpStores } from './tenant-idp-database.js';
import type { RealmSettings } from './realm-settings.js';
import { RealmSignIn } from './realm-sign-in.js';
import { RealmSourceKind } from './tenant-idp-options.js';
import { UpstreamOidcSource } from './upstream-oidc-source.js';
import { IdentityPlatformSource } from './identity-platform-source.js';

/** The HTTP clients the realms' sources use instead of their defaults (tests: fakes of the upstreams). */
export class IdpSourceClients
{
    public static readonly Default = new IdpSourceClients(undefined, undefined);

    public constructor(public readonly Upstream: IHttpClient | undefined, public readonly IdentityPlatform: IHttpClient | undefined)
    {
        Object.freeze(this);
    }
}

/** An account's profile as tokens carry it. */
export class AccountProfile
{
    public constructor(public readonly Email: string, public readonly Name: string, public readonly Active: boolean)
    {
        Object.freeze(this);
    }
}

/**
 * One realm of the sign-in service: its settings (token policy, sources), its issuer and its accounts. Local accounts
 * live in the SQL identity stores (email, password hash in the realm's sealed secrets) with a profile beside them;
 * upstream identities are linked to realm accounts at their first sign-in. Every read and write is scoped to the realm.
 */
export class IdpRealm
{
    private static readonly SecretRefPrefix = 'idp-password/';
    private static readonly NoName = '';

    private readonly hasher = new Argon2PasswordHasher();
    private readonly authenticator: LocalPasswordAuthenticator;
    private readonly realm: Realm;
    private readonly upstreams: ReadonlyMap<string, UpstreamOidcSource>;

    private constructor(
        public readonly Settings: RealmSettings,
        public readonly Issuer: string,
        private readonly stores: TenantIdpStores,
        /** The realm's sealed secrets: password hashes and the secrets its configuration names (`secret:realm/...`). */
        public readonly Secrets: ISecretStore,
        upstreams: readonly UpstreamOidcSource[],
        public readonly IdentityPlatform: IdentityPlatformSource | undefined,
        private readonly now: () => Date)
    {
        this.realm = new Realm(Settings.RealmId, RealmKind.SelfHosted, Settings.DisplayName);
        this.authenticator = new LocalPasswordAuthenticator(stores.Accounts, Secrets, this.hasher);
        this.upstreams = new Map(upstreams.map(source => [source.Id, source]));
    }

    public static Open(settings: RealmSettings, issuer: string, stores: TenantIdpStores, secrets: ISecretStore, clients: IdpSourceClients = IdpSourceClients.Default, now: () => Date = () => new Date()): IdpRealm
    {
        const upstreams = settings.Upstreams.map(upstream => UpstreamOidcSource.For(upstream, settings.RealmId, issuer, stores.FlowStates, clients.Upstream, now));
        const identityPlatform = settings.IdentityPlatform === undefined ? undefined : IdentityPlatformSource.For(settings.IdentityPlatform, clients.IdentityPlatform, now);
        return new IdpRealm(settings, issuer, stores, secrets, upstreams, identityPlatform, now);
    }

    public static SecretRefFor(principalId: string): string
    {
        return IdpRealm.SecretRefPrefix + principalId;
    }

    public get Id(): string
    {
        return this.Settings.RealmId;
    }

    public get DisplayName(): string
    {
        return this.Settings.DisplayName;
    }

    public get HasLocalAccounts(): boolean
    {
        return this.Settings.Local !== undefined;
    }

    public Upstream(sourceId: string): UpstreamOidcSource | undefined
    {
        return this.upstreams.get(sourceId);
    }

    public Upstreams(): readonly UpstreamOidcSource[]
    {
        return [...this.upstreams.values()];
    }

    /** Creates the local account unless it exists (then only its display name follows). */
    public async SeedAccount(email: string, principalId: string, password: string, displayName: string): Promise<void>
    {
        const existing = await this.stores.Accounts.FindByPrincipalId(this.realm, principalId);
        if (existing === null)
        {
            const ref = IdpRealm.SecretRefFor(principalId);
            await this.Secrets.Put(ref, await this.hasher.Hash(password));
            await this.stores.Accounts.CreateAccount(this.realm, email, principalId, ref);
        }
        await this.stores.Profiles.PutName(this.Id, principalId, displayName);
    }

    /**
     * The local sign-in of `email` with `password`, checked against the credential change stamp: a sign-in whose check
     * began before the password changed is refused. Undefined for any failure (one answer, no enumeration).
     */
    public async AuthenticatePassword(email: string, password: string): Promise<RealmSignIn | undefined>
    {
        if (!this.HasLocalAccounts)
        {
            return undefined;
        }
        const startedAt = this.now();
        const presented = new PresentedSecret(password);
        try
        {
            const result = await this.authenticator.Authenticate(new Credential(AuthMethod.Local, email), presented, this.realm);
            if (!(result instanceof AuthenticatedResult))
            {
                return undefined;
            }
            const account = await this.stores.Accounts.FindByPrincipalId(this.realm, result.Principal.Id);
            if (account === null || account.Disabled || await this.IsStale(account.PrincipalId, startedAt))
            {
                return undefined;
            }
            const name = await this.stores.Profiles.Name(this.Id, account.PrincipalId) ?? IdpRealm.NoName;
            return new RealmSignIn(account.PrincipalId, RealmSourceKind.Local, account.PrincipalId, [], account.Email, name, undefined, startedAt);
        }
        finally
        {
            presented.Clear();
        }
    }

    /** An admin-forced reset (no current password); false for an unknown account or an empty password. */
    public async ResetPassword(principalId: string, newPassword: string): Promise<boolean>
    {
        if (newPassword.length === 0 || (await this.stores.Accounts.FindByPrincipalId(this.realm, principalId)) === null)
        {
            return false;
        }
        await this.Secrets.Put(IdpRealm.SecretRefFor(principalId), await this.hasher.Hash(newPassword));
        // Stamped AFTER the new hash is stored: a sign-in that read the old hash started before the stamp, so it is refused.
        await this.stores.Profiles.StampCredentialsChanged(this.Id, principalId, this.now());
        return true;
    }

    /** Whether something authenticated at `at` predates the account's last credential change. */
    public async IsStale(accountId: string, at: Date): Promise<boolean>
    {
        const changed = await this.stores.Profiles.CredentialsChangedAt(this.Id, accountId);
        return changed !== undefined && changed.getTime() >= at.getTime();
    }

    /** The realm account an upstream identity signs in as (linked at its first sign-in). */
    public async LinkUpstream(source: string, subject: string, email: string, name: string): Promise<string>
    {
        return (await this.stores.Federated.Link(this.Id, source, subject, email, name, this.now())).AccountId;
    }

    /** The current profile of a realm account (local or federated); undefined when the realm has no such account. */
    public async Profile(accountId: string): Promise<AccountProfile | undefined>
    {
        const local = await this.stores.Accounts.FindByPrincipalId(this.realm, accountId);
        if (local !== null)
        {
            return new AccountProfile(local.Email, await this.stores.Profiles.Name(this.Id, accountId) ?? IdpRealm.NoName, !local.Disabled);
        }
        const federated = await this.stores.Federated.ByAccount(this.Id, accountId);
        return federated === undefined ? undefined : new AccountProfile(federated.Email, federated.DisplayName, !federated.Disabled);
    }

    /** Disables or enables a realm account (local or federated); false when the realm has no such account. */
    public async SetDisabled(accountId: string, disabled: boolean): Promise<boolean>
    {
        if ((await this.stores.Accounts.FindByPrincipalId(this.realm, accountId)) !== null)
        {
            if (disabled)
            {
                await this.stores.Accounts.Disable(this.realm, accountId);
            }
            else
            {
                await this.stores.Accounts.Enable(this.realm, accountId);
            }
            return true;
        }
        return await this.stores.Federated.SetDisabled(this.Id, accountId, disabled);
    }

    /** Whether the account may sign in now (it exists and is not disabled). */
    public async IsActive(accountId: string): Promise<boolean>
    {
        return (await this.Profile(accountId))?.Active === true;
    }
}
