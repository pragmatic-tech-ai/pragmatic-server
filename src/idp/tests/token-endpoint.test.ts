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
    public static readonly OtherClientId = 'client-2';
    public static readonly Secret = 'secret';
    public static readonly RedirectUri = 'https://app.example/cb';
    public static readonly EvilRedirectUri = 'https://evil/cb';
    public static readonly Verifier = 'verifier-abcdefghijklmnopqrstuvwxyz0123456789';
    public static readonly Nonce = 'no-1';
    public static readonly Sub = 'p-1';
    public static readonly Email = 'ada@example.com';
    public static readonly Name = 'Ada Lovelace';
    public static readonly EmailClaim = 'email';
    public static readonly NameClaim = 'name';
    public static readonly KeyFile = 'key.pem';
    public static readonly TempPrefix = 'idp-token-';
    public static readonly GrantTypeField = 'grant_type';
    public static readonly CodeField = 'code';
    public static readonly VerifierField = 'code_verifier';
    public static readonly RedirectField = 'redirect_uri';
    public static readonly ClientIdField = 'client_id';
    public static readonly ClientSecretField = 'client_secret';
    public static readonly AuthorizationCode = 'authorization_code';
    public static readonly Bearer = 'Bearer';
    public static readonly InvalidGrant = 'invalid_grant';
    public static readonly InvalidClient = 'invalid_client';
    public static readonly HashAlgorithm = 'sha256';
    public static readonly Base64Url = 'base64url';
    public static readonly Rs256 = 'RS256';
    public static readonly WrongVerifier = 'nope';
    public static readonly WrongSecret = 'wrong';
    public static readonly LifetimeSeconds = 300;
    public static readonly CodeTtlMs = 60_000;

    public codes = new InMemoryAuthorizationCodeStore();
    public key!: IdpSigningKey;
    public endpoint!: TokenEndpoint;

    public static async Run(body: (f: TokenFixture) => Promise<void>): Promise<void>
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), TokenFixture.TempPrefix));
        try
        {
            const f = new TokenFixture();
            f.key = await IdpSigningKey.LoadOrCreate(path.join(dir, TokenFixture.KeyFile));
            const clients = new IdpClientStore();
            await clients.Register(TokenFixture.TenantId, TokenFixture.ClientId, [TokenFixture.RedirectUri], TokenFixture.Secret);
            const fixedNow = new Date(Math.floor(Date.now() / 1000) * 1000);
            f.endpoint = new TokenEndpoint(TokenFixture.BaseUrl, f.key, f.codes, clients, () => fixedNow);
            await body(f);
        }
        finally
        {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    public async IssueCode(name: string = TokenFixture.Name): Promise<string>
    {
        const challenge = createHash(TokenFixture.HashAlgorithm).update(TokenFixture.Verifier).digest(TokenFixture.Base64Url);
        return this.codes.Issue(new AuthorizationCodeBinding(TokenFixture.Sub, TokenFixture.TenantId, TokenFixture.ClientId,
            TokenFixture.RedirectUri, TokenFixture.Nonce, challenge, new Date(Date.now() + TokenFixture.CodeTtlMs),
            TokenFixture.Email, name));
    }

    public static Form(code: string, overrides: Record<string, string> = {}): URLSearchParams
    {
        return new URLSearchParams({
            [TokenFixture.GrantTypeField]: TokenFixture.AuthorizationCode,
            [TokenFixture.CodeField]: code,
            [TokenFixture.VerifierField]: TokenFixture.Verifier,
            [TokenFixture.RedirectField]: TokenFixture.RedirectUri,
            [TokenFixture.ClientIdField]: TokenFixture.ClientId,
            [TokenFixture.ClientSecretField]: TokenFixture.Secret,
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
        assert.equal(body.token_type, TokenFixture.Bearer);
        assert.equal(body.expires_in, TokenFixture.LifetimeSeconds);
        assert.ok(body.access_token.length > 0);
        const { payload } = await jwtVerify(body.id_token, createLocalJWKSet(f.key.PublicJwks()), {
            issuer: `${TokenFixture.BaseUrl}/${TokenFixture.TenantId}`,
            audience: TokenFixture.ClientId,
            algorithms: [TokenFixture.Rs256]
        });
        assert.ok(typeof payload.sub === 'string' && payload.sub.length > 0);
        assert.equal(payload.nonce, TokenFixture.Nonce);
        assert.equal(typeof payload.iat, 'number');
        assert.equal(payload.exp, (payload.iat as number) + TokenFixture.LifetimeSeconds);
    });
});

test('the id_token carries email and name claims', async () =>
{
    await TokenFixture.Run(async f =>
    {
        const r = await f.endpoint.Handle(TokenFixture.TenantId, TokenFixture.Form(await f.IssueCode()));
        assert.equal(r.status, 200);
        const body = r.body as { id_token: string };
        const { payload } = await jwtVerify(body.id_token, createLocalJWKSet(f.key.PublicJwks()), {
            issuer: `${TokenFixture.BaseUrl}/${TokenFixture.TenantId}`,
            audience: TokenFixture.ClientId,
            algorithms: [TokenFixture.Rs256]
        });
        assert.equal(payload[TokenFixture.EmailClaim], TokenFixture.Email);
        assert.equal(payload[TokenFixture.NameClaim], TokenFixture.Name);
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
        assert.deepEqual(r.body, { error: TokenFixture.InvalidGrant });
    });
});

test('a wrong PKCE verifier is rejected', async () =>
{
    await TokenFixture.Run(async f =>
    {
        const r = await f.endpoint.Handle(TokenFixture.TenantId,
            TokenFixture.Form(await f.IssueCode(), { [TokenFixture.VerifierField]: TokenFixture.WrongVerifier }));
        assert.equal(r.status, 400);
    });
});

test('a client_id or redirect_uri not matching the code binding is rejected', async () =>
{
    await TokenFixture.Run(async f =>
    {
        const bad = await f.endpoint.Handle(TokenFixture.TenantId,
            TokenFixture.Form(await f.IssueCode(), { [TokenFixture.RedirectField]: TokenFixture.EvilRedirectUri }));
        assert.equal(bad.status, 400);
        const other = await f.endpoint.Handle(TokenFixture.TenantId,
            TokenFixture.Form(await f.IssueCode(), { [TokenFixture.ClientIdField]: TokenFixture.OtherClientId }));
        assert.notEqual(other.status, 200);
    });
});

test('a wrong client secret is rejected', async () =>
{
    await TokenFixture.Run(async f =>
    {
        const r = await f.endpoint.Handle(TokenFixture.TenantId,
            TokenFixture.Form(await f.IssueCode(), { [TokenFixture.ClientSecretField]: TokenFixture.WrongSecret }));
        assert.equal(r.status, 401);
        assert.deepEqual(r.body, { error: TokenFixture.InvalidClient });
    });
});

test('an account with no name still mints a valid id_token with email and no name claim', async () =>
{
    await TokenFixture.Run(async f =>
    {
        const r = await f.endpoint.Handle(TokenFixture.TenantId, TokenFixture.Form(await f.IssueCode('')));
        assert.equal(r.status, 200);
        const body = r.body as { id_token: string };
        const { payload } = await jwtVerify(body.id_token, createLocalJWKSet(f.key.PublicJwks()), {
            issuer: `${TokenFixture.BaseUrl}/${TokenFixture.TenantId}`,
            audience: TokenFixture.ClientId,
            algorithms: [TokenFixture.Rs256]
        });
        assert.equal(payload[TokenFixture.EmailClaim], TokenFixture.Email);
        assert.equal(TokenFixture.NameClaim in payload, false);
    });
});
