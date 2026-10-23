import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { AuthorizationCodeBinding, InMemoryAuthorizationCodeStore } from '../authorization-code-store.js';
import { IdpClientStore } from '../idp-client-store.js';
import { IdpSigningKey } from '../idp-signing-key.js';
import { TokenEndpoint } from '../token-endpoint.js';

class TokenFixture
{
    public static readonly BaseUrl = 'https://idp.test:8443';
    public static readonly TenantId = 'tenant-1';
    public static readonly ClientId = 'client-1';
    public static readonly Secret = 'secret';
    public static readonly RedirectUri = 'https://app.example/cb';
    public static readonly Verifier = 'verifier-abcdefghijklmnopqrstuvwxyz0123456789';
    public static readonly Nonce = 'no-1';
    public static readonly Sub = 'p-1';

    public codes = new InMemoryAuthorizationCodeStore();
    public key!: IdpSigningKey;
    public endpoint!: TokenEndpoint;

    public static async Run(body: (f: TokenFixture) => Promise<void>): Promise<void>
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idp-token-'));
        try
        {
            const f = new TokenFixture();
            f.key = await IdpSigningKey.LoadOrCreate(path.join(dir, 'key.pem'));
            const clients = new IdpClientStore();
            await clients.Register(TokenFixture.TenantId, TokenFixture.ClientId, [TokenFixture.RedirectUri], TokenFixture.Secret);
            f.endpoint = new TokenEndpoint(TokenFixture.BaseUrl, f.key, f.codes, clients);
            await body(f);
        }
        finally
        {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    public async IssueCode(): Promise<string>
    {
        const challenge = createHash('sha256').update(TokenFixture.Verifier).digest('base64url');
        return this.codes.Issue(new AuthorizationCodeBinding(TokenFixture.Sub, TokenFixture.TenantId, TokenFixture.ClientId,
            TokenFixture.RedirectUri, TokenFixture.Nonce, challenge, new Date(Date.now() + 60_000)));
    }

    public static Form(code: string, overrides: Record<string, string> = {}): URLSearchParams
    {
        return new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            code_verifier: TokenFixture.Verifier,
            redirect_uri: TokenFixture.RedirectUri,
            client_id: TokenFixture.ClientId,
            client_secret: TokenFixture.Secret,
            ...overrides
        });
    }
}

test('valid code + verifier + secret mints an id_token that verifies against JWKS with the required claims', async () =>
{
    await TokenFixture.Run(async f =>
    {
        const r = await f.endpoint.Handle(TokenFixture.TenantId, TokenFixture.Form(await f.IssueCode()));
        assert.equal(r.status, 200);
        const body = r.body as { id_token: string; access_token: string; token_type: string; expires_in: number };
        assert.equal(body.token_type, 'Bearer');
        assert.equal(body.expires_in, 300);
        assert.ok(body.access_token.length > 0);
        const { payload } = await jwtVerify(body.id_token, createLocalJWKSet(f.key.PublicJwks()), {
            issuer: `${TokenFixture.BaseUrl}/${TokenFixture.TenantId}`,
            audience: TokenFixture.ClientId,
            algorithms: ['RS256']
        });
        assert.ok(typeof payload.sub === 'string' && payload.sub.length > 0);
        assert.equal(payload.nonce, TokenFixture.Nonce);
    });
});

test('a replayed code is rejected', async () =>
{
    await TokenFixture.Run(async f =>
    {
        const code = await f.IssueCode();
        assert.equal((await f.endpoint.Handle(TokenFixture.TenantId, TokenFixture.Form(code))).status, 200);
        const r = await f.endpoint.Handle(TokenFixture.TenantId, TokenFixture.Form(code));
        assert.equal(r.status, 400);
        assert.deepEqual(r.body, { error: 'invalid_grant' });
    });
});

test('a wrong PKCE verifier is rejected', async () =>
{
    await TokenFixture.Run(async f =>
    {
        const r = await f.endpoint.Handle(TokenFixture.TenantId, TokenFixture.Form(await f.IssueCode(), { code_verifier: 'nope' }));
        assert.equal(r.status, 400);
    });
});

test('a client_id or redirect_uri not matching the code binding is rejected', async () =>
{
    await TokenFixture.Run(async f =>
    {
        const bad = await f.endpoint.Handle(TokenFixture.TenantId, TokenFixture.Form(await f.IssueCode(), { redirect_uri: 'https://evil/cb' }));
        assert.equal(bad.status, 400);
        const other = await f.endpoint.Handle(TokenFixture.TenantId, TokenFixture.Form(await f.IssueCode(), { client_id: 'client-2' }));
        assert.notEqual(other.status, 200);
    });
});

test('a wrong client secret is rejected', async () =>
{
    await TokenFixture.Run(async f =>
    {
        const r = await f.endpoint.Handle(TokenFixture.TenantId, TokenFixture.Form(await f.IssueCode(), { client_secret: 'wrong' }));
        assert.equal(r.status, 401);
        assert.deepEqual(r.body, { error: 'invalid_client' });
    });
});
