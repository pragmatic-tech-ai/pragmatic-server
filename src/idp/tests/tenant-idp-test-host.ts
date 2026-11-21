import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component';
import { PgSession } from '@pragmatic-tech-ai/pragmatic-realm-adapters';
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing';
import type { ISqlSession } from '@pragmatic-tech-ai/todl';
import { DevCa, IdpTlsMaterial } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc';
import { IdpLoginPage } from '../idp-login-page.js';
import type { IdpSourceClients } from '../idp-realm.js';
import { IdpSigningKey } from '../idp-signing-key.js';
import { IdpTlsIdentity } from '../idp-tls-identity.js';
import { RealmIssuer } from '@pragmatic-tech-ai/pragmatic-identity';
import type { RealmConfiguration } from '../realm-configuration-reader.js';
import { TenantIdpDatabase } from '../tenant-idp-database.js';
import { TenantIdpService } from '../tenant-idp-service.js';

/** One HTTPS answer of the test client. */
export class IdpTestReply
{
    public constructor(public readonly Status: number, public readonly Headers: Record<string, string | string[] | undefined>, public readonly Text: string)
    {
    }

    public Json(): any
    {
        return JSON.parse(this.Text);
    }

    public Header(name: string): string | undefined
    {
        const value = this.Headers[name.toLowerCase()];
        return Array.isArray(value) ? value.join(', ') : value;
    }

    /** The first Set-Cookie pair (`name=value`), or undefined. */
    public Cookie(): string | undefined
    {
        const raw = this.Headers['set-cookie'];
        const first = Array.isArray(raw) ? raw[0] : raw;
        return first?.split(';')[0];
    }
}

/** A request of the test client: a form or a JSON body, extra headers. */
export interface IdpTestRequest
{
    Form?: Record<string, string>;
    Json?: unknown;
    Headers?: Record<string, string>;
}

/** HTTPS to the service under test, trusting its development CA, never following redirects. */
export class IdpTestHttp
{
    public constructor(private readonly ca: string)
    {
    }

    public Send(method: string, url: string, options: IdpTestRequest = {}): Promise<IdpTestReply>
    {
        const target = new URL(url);
        const headers: Record<string, string> = { ...options.Headers };
        let body: string | undefined;
        if (options.Form !== undefined)
        {
            body = new URLSearchParams(options.Form).toString();
            headers['content-type'] = 'application/x-www-form-urlencoded';
        }
        else if (options.Json !== undefined)
        {
            body = JSON.stringify(options.Json);
            headers['content-type'] = 'application/json';
        }
        if (body !== undefined)
        {
            headers['content-length'] = String(Buffer.byteLength(body));
        }
        return new Promise<IdpTestReply>((resolve, reject) =>
        {
            const req = request({ host: target.hostname, port: target.port, path: target.pathname + target.search, method, ca: this.ca, headers }, res =>
            {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => resolve(new IdpTestReply(res.statusCode ?? 0, res.headers, Buffer.concat(chunks).toString('utf8'))));
            });
            req.on('error', reject);
            req.end(body);
        });
    }
}

export interface TenantIdpTestHostOptions
{
    Configurations?: readonly RealmConfiguration[];
    Applications?: readonly ComponentDescriptor[];
    SourceClients?: IdpSourceClients;
    Now?: () => Date;
    /** An existing session (several hosts over one database); default a fresh pg-mem database. */
    Session?: ISqlSession;
    MasterKey?: Buffer;
}

/**
 * The realm sign-in service in process for tests: a fresh pg-mem database, a development CA for `localhost`, a free
 * port (so issuers name the real URL), the placeholder login page and one admin token.
 */
export class TenantIdpTestHost
{
    public static readonly AdminToken = 'test-admin-token';
    public static readonly Localhost = 'localhost';
    public static readonly Loopback = '127.0.0.1';
    private static readonly DirPrefix = 'tenant-idp-test-';
    private static readonly AdminPrefix = '/_admin/realms/';

    private constructor(
        public readonly Service: TenantIdpService,
        public readonly BaseUrl: string,
        public readonly Ca: string,
        public readonly Http: IdpTestHttp,
        public readonly Session: ISqlSession,
        public readonly MasterKey: Buffer,
        private readonly dir: string)
    {
    }

    public static async Start(options: TenantIdpTestHostOptions = {}): Promise<TenantIdpTestHost>
    {
        const T = TenantIdpTestHost;
        const dir = mkdtempSync(join(tmpdir(), T.DirPrefix));
        const ca = DevCa.EnsureAt(join(dir, 'tls'), T.Localhost);
        const material = IdpTlsMaterial.Load({ certFile: ca.certFile, keyFile: ca.keyFile });
        const port = await T.FreePort();
        const baseUrl = `https://${T.Localhost}:${port}`;
        const session = options.Session ?? new PgSession(SqlTestSessions.MemPool());
        const masterKey = options.MasterKey ?? Buffer.alloc(32, 7);
        const service = await TenantIdpService.Open({
            Database: TenantIdpDatabase.Over(session),
            SigningKey: await IdpSigningKey.LoadOrCreate(join(dir, 'signing-key.pem')),
            MasterKey: masterKey,
            BaseUrl: baseUrl,
            Configurations: options.Configurations ?? [],
            Applications: options.Applications ?? [],
            LoginPage: IdpLoginPage.Placeholder(),
            SecureCookie: true,
            TrustedProxy: false,
            Tls: new IdpTlsIdentity(material.key, material.cert),
            AdminTokens: [T.AdminToken],
            SourceClients: options.SourceClients,
            Now: options.Now,
        });
        await service.Listen(port, T.Loopback);
        const caPem = readFileSync(ca.caFile, 'utf8');
        return new TenantIdpTestHost(service, baseUrl, caPem, new IdpTestHttp(caPem), session, masterKey, dir);
    }

    public Issuer(realm: string): string
    {
        return RealmIssuer.Of(this.BaseUrl, realm);
    }

    /** One admin API call under `/_admin/realms/<path>` with the admin token. */
    public Admin(method: string, path: string, body?: unknown): Promise<IdpTestReply>
    {
        return this.Http.Send(method, this.BaseUrl + TenantIdpTestHost.AdminPrefix + path, { Json: body, Headers: { authorization: 'Bearer ' + TenantIdpTestHost.AdminToken } });
    }

    /** Creates a realm, a local account and a client through the admin API. */
    public async Provision(realm: string, account: { email: string; principalId: string; password: string; displayName?: string }, client: { clientId: string; secret: string; redirectUris: string[]; postLogoutRedirectUris?: string[] }): Promise<void>
    {
        await this.Expect(this.Admin('PUT', realm, { displayName: realm }));
        await this.Expect(this.Admin('POST', realm + '/accounts', { ...account, displayName: account.displayName ?? account.email }));
        await this.Expect(this.Admin('POST', realm + '/clients', client));
    }

    public async Close(): Promise<void>
    {
        await this.Service.Close();
        rmSync(this.dir, { recursive: true, force: true });
    }

    private async Expect(reply: Promise<IdpTestReply>): Promise<void>
    {
        const answered = await reply;
        if (answered.Status !== 200)
        {
            throw new Error(`admin call failed: ${answered.Status} ${answered.Text}`);
        }
    }

    private static FreePort(): Promise<number>
    {
        return new Promise<number>((resolve, reject) =>
        {
            const probe = createServer();
            probe.once('error', reject);
            probe.listen(0, TenantIdpTestHost.Loopback, () =>
            {
                const address = probe.address();
                const port = typeof address === 'object' && address !== null ? address.port : 0;
                probe.close(() => resolve(port));
            });
        });
    }
}
