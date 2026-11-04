import { readFile, rename, writeFile } from 'node:fs/promises';
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

/** One persisted client row: the same fields as OidcClient (the secret only as its argon2 hash). */
type ClientRow = { clientId: string; tenantId: string; redirectUris: string[]; secretHash: string };

/**
 * Confidential-client registry, keyed by (tenantId, clientId). `new IdpClientStore()` is in-memory; `Open(file)` is durable:
 * every Register/Remove rewrites the file (atomically, serialized), so a restarted IdP keeps the clients the control plane
 * registered. The file holds secret hashes only, never a secret.
 */
export class IdpClientStore
{
    private static readonly DummySecret = 'idp-client-store-dummy-secret';
    private static readonly Encoding = 'utf8';
    private static readonly TmpSuffix = '.tmp';
    private static readonly NotFound = 'ENOENT';
    private static readonly LoopbackScheme = 'http:';
    private static readonly LoopbackHost = '127.0.0.1';
    private static readonly LoopbackOrigin = 'http://127.0.0.1';
    private static readonly PortMark = ':';
    private static readonly QueryMark = '?';
    private static readonly FragmentMark = '#';
    private static readonly UnreadableMessage = 'IdpClientStore: cannot read the client registrations at ';

    private readonly hasher = new Argon2PasswordHasher();
    private readonly clients = new Map<string, OidcClient>();
    private readonly dummyHash: Promise<string> = this.hasher.Hash(IdpClientStore.DummySecret);
    private writes: Promise<void> = Promise.resolve();

    public constructor(private readonly file?: string)
    {
    }

    /** A durable store backed by `file` (created on the first write). Throws when the file exists but cannot be read. */
    public static async Open(file: string): Promise<IdpClientStore>
    {
        const store = new IdpClientStore(file);
        await store.Load();
        return store;
    }

    public async Register(tenantId: string, clientId: string, redirectUris: readonly string[], secret: string): Promise<void>
    {
        const hash = await this.hasher.Hash(secret);
        this.clients.set(IdpClientStore.KeyFor(tenantId, clientId), new OidcClient(clientId, tenantId, [...redirectUris], hash));
        await this.Persist();
    }

    public Find(tenantId: string, clientId: string): OidcClient | undefined
    {
        return this.clients.get(IdpClientStore.KeyFor(tenantId, clientId));
    }

    /** Removes the client; returns whether it existed. */
    public async Remove(tenantId: string, clientId: string): Promise<boolean>
    {
        const existed = this.clients.delete(IdpClientStore.KeyFor(tenantId, clientId));
        if (existed)
        {
            await this.Persist();
        }
        return existed;
    }

    /** Uniform: an unknown client costs the same argon2 verify as a wrong secret and yields false. */
    public async VerifySecret(tenantId: string, clientId: string, presented: string): Promise<boolean>
    {
        const client = this.Find(tenantId, clientId);
        if (client === undefined)
        {
            await this.hasher.Verify(presented, await this.dummyHash);
            return false;
        }
        return this.hasher.Verify(presented, client.SecretHash);
    }

    /**
     * Exact string equality against the registered allowlist (no prefix, normalization or query tolerance), plus the
     * RFC 8252 section 7.3 loopback rule: a registered portless http://127.0.0.1 URI matches the identical URI on any port 1-65535.
     */
    public RedirectAllowed(tenantId: string, clientId: string, redirectUri: string): boolean
    {
        const client = this.Find(tenantId, clientId);
        return client !== undefined && (client.RedirectUris.includes(redirectUri) || client.RedirectUris.some(r => IdpClientStore.IsLoopbackMatch(r, redirectUri)));
    }

    private static IsLoopbackMatch(registered: string, presented: string): boolean
    {
        if (!registered.startsWith(IdpClientStore.LoopbackOrigin) || presented.includes(IdpClientStore.QueryMark) || presented.includes(IdpClientStore.FragmentMark))
        {
            return false;
        }
        try
        {
            const reg = new URL(registered);
            const pres = new URL(presented);
            if (reg.protocol !== IdpClientStore.LoopbackScheme || reg.hostname !== IdpClientStore.LoopbackHost || reg.port !== '' || registered.startsWith(IdpClientStore.LoopbackOrigin + IdpClientStore.PortMark))
            {
                return false;
            }
            const port = Number(pres.port);
            if (pres.protocol !== IdpClientStore.LoopbackScheme || pres.hostname !== IdpClientStore.LoopbackHost || !Number.isInteger(port) || port < 1 || port > 65535)
            {
                return false;
            }
            // Byte-identical path: URL parsing would otherwise fold dot segments and escapes into a false match.
            return presented === IdpClientStore.LoopbackOrigin + IdpClientStore.PortMark + pres.port + registered.slice(IdpClientStore.LoopbackOrigin.length);
        }
        catch
        {
            return false;
        }
    }

    private static KeyFor(tenantId: string, clientId: string): string
    {
        return JSON.stringify([tenantId, clientId]);
    }

    private async Load(): Promise<void>
    {
        let rows: ClientRow[];
        try
        {
            rows = JSON.parse(await readFile(this.file as string, IdpClientStore.Encoding)) as ClientRow[];
            if (!Array.isArray(rows))
            {
                throw new Error();
            }
        }
        catch (e)
        {
            if ((e as NodeJS.ErrnoException).code === IdpClientStore.NotFound)
            {
                return;
            }
            // Refuse to start rather than silently forget every client (a corrupt file would otherwise look like "no clients").
            throw new Error(IdpClientStore.UnreadableMessage + this.file);
        }
        for (const r of rows)
        {
            this.clients.set(IdpClientStore.KeyFor(r.tenantId, r.clientId), new OidcClient(r.clientId, r.tenantId, [...r.redirectUris], r.secretHash));
        }
    }

    // Serialized whole-file rewrite through a temp file + rename, so a crash mid-write never leaves a torn file.
    private Persist(): Promise<void>
    {
        if (this.file === undefined)
        {
            return Promise.resolve();
        }
        const file = this.file;
        const run = this.writes.then(async () =>
        {
            const rows: ClientRow[] = [...this.clients.values()].map(c => ({ clientId: c.ClientId, tenantId: c.TenantId, redirectUris: [...c.RedirectUris], secretHash: c.SecretHash }));
            const tmp = file + IdpClientStore.TmpSuffix;
            await writeFile(tmp, JSON.stringify(rows), IdpClientStore.Encoding);
            await rename(tmp, file);
        });
        // A failed write must not wedge later ones; the caller still sees this write's error.
        this.writes = run.catch(() => undefined);
        return run;
    }
}
