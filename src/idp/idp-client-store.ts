import { Argon2PasswordHasher } from '@pragmatic-tech-ai/todl-identity-local';

/** A registered confidential OIDC client. Holds only the secret's hash, never the secret. */
export class OidcClient
{
    public constructor(
        public readonly ClientId: string,
        public readonly TenantId: string,
        public readonly RedirectUris: readonly string[],
        public readonly SecretHash: string)
    {
    }
}

/**
 * In-memory confidential-client registry, keyed by (tenantId, clientId). A persistent
 * implementation can replace it later behind the same public surface.
 */
export class IdpClientStore
{
    private static readonly KeySeparator = '\u0000';
    private static readonly DummySecret = 'idp-client-store-dummy-secret';

    private readonly hasher = new Argon2PasswordHasher();
    private readonly clients = new Map<string, OidcClient>();
    private dummyHash: Promise<string> | undefined;

    public async Register(tenantId: string, clientId: string, redirectUris: readonly string[], secret: string): Promise<void>
    {
        const hash = await this.hasher.Hash(secret);
        this.clients.set(IdpClientStore.KeyFor(tenantId, clientId), new OidcClient(clientId, tenantId, [...redirectUris], hash));
    }

    public Find(tenantId: string, clientId: string): OidcClient | undefined
    {
        return this.clients.get(IdpClientStore.KeyFor(tenantId, clientId));
    }

    /** Uniform: an unknown client costs the same argon2 verify as a wrong secret and yields false. */
    public async VerifySecret(tenantId: string, clientId: string, presented: string): Promise<boolean>
    {
        const client = this.Find(tenantId, clientId);
        if (client === undefined)
        {
            await this.hasher.Verify(presented, await this.DummyHash());
            return false;
        }
        return this.hasher.Verify(presented, client.SecretHash);
    }

    /** Exact string equality against the registered allowlist; no prefix, normalization or query tolerance. */
    public RedirectAllowed(tenantId: string, clientId: string, redirectUri: string): boolean
    {
        const client = this.Find(tenantId, clientId);
        return client !== undefined && client.RedirectUris.includes(redirectUri);
    }

    private DummyHash(): Promise<string>
    {
        this.dummyHash ??= this.hasher.Hash(IdpClientStore.DummySecret);
        return this.dummyHash;
    }

    private static KeyFor(tenantId: string, clientId: string): string
    {
        return tenantId + IdpClientStore.KeySeparator + clientId;
    }
}
