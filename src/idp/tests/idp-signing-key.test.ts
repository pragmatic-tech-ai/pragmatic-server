import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { calculateJwkThumbprint, createLocalJWKSet, jwtVerify } from 'jose';
import { IdpSigningKey } from '../idp-signing-key.js';

class SigningKeyTestFixture
{
    public static readonly DirPrefix = 'idp-signing-key-';
    public static readonly KeyFileName = 'idp.pem';
    public static readonly NestedDir = 'nested';
    public static readonly Algorithm = 'RS256';
    public static readonly KeyUse = 'sig';
    public static readonly ExpectedJwkKeys = ['alg', 'e', 'kid', 'kty', 'n', 'use'];
    public static readonly SignatureFlipFrom = 'A';
    public static readonly SignatureFlipTo = 'B';

    public static async WithTempKeyFile(body: (file: string) => Promise<void>): Promise<void>
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), SigningKeyTestFixture.DirPrefix));
        try
        {
            await body(path.join(dir, SigningKeyTestFixture.NestedDir, SigningKeyTestFixture.KeyFileName));
        }
        finally
        {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    public static Tamper(token: string): string
    {
        const parts = token.split('.');
        const sig = parts[2]!;
        const flipped = sig[0] === SigningKeyTestFixture.SignatureFlipFrom
            ? SigningKeyTestFixture.SignatureFlipTo
            : SigningKeyTestFixture.SignatureFlipFrom;
        parts[2] = flipped + sig.slice(1);
        return parts.join('.');
    }
}

test('signs a token verifiable against its own JWKS', async () =>
{
    await SigningKeyTestFixture.WithTempKeyFile(async file =>
    {
        const key = await IdpSigningKey.LoadOrCreate(file);
        const token = await key.Sign({ iss: 'x', aud: 'c', sub: 'u' });
        const result = await jwtVerify(token, createLocalJWKSet(key.PublicJwks()), { algorithms: [SigningKeyTestFixture.Algorithm] });
        assert.equal(result.payload.iss, 'x');
        assert.equal(result.payload.aud, 'c');
        assert.equal(result.payload.sub, 'u');
        assert.equal(result.protectedHeader.kid, key.Kid());
    });
});

test('JWKS entry carries kid, alg RS256, use sig and no private members', async () =>
{
    await SigningKeyTestFixture.WithTempKeyFile(async file =>
    {
        const key = await IdpSigningKey.LoadOrCreate(file);
        const jwk = key.PublicJwks().keys[0]!;
        assert.equal(jwk.kid, key.Kid());
        assert.equal(jwk.alg, SigningKeyTestFixture.Algorithm);
        assert.equal(jwk.use, SigningKeyTestFixture.KeyUse);
        assert.deepEqual(Object.keys(jwk).sort(), SigningKeyTestFixture.ExpectedJwkKeys);
    });
});

test('reload from the same file yields the same kid and public key', async () =>
{
    await SigningKeyTestFixture.WithTempKeyFile(async file =>
    {
        const first = await IdpSigningKey.LoadOrCreate(file);
        const second = await IdpSigningKey.LoadOrCreate(file);
        assert.equal(second.Kid(), first.Kid());
        assert.deepEqual(second.PublicJwks(), first.PublicJwks());
    });
});

test('kid equals an independent thumbprint of the public JWK', async () =>
{
    await SigningKeyTestFixture.WithTempKeyFile(async file =>
    {
        const key = await IdpSigningKey.LoadOrCreate(file);
        const jwk = key.PublicJwks().keys[0]!;
        assert.equal(key.Kid(), await calculateJwkThumbprint(jwk));
    });
});

test('rejects a token verified against a different key or tampered', async () =>
{
    await SigningKeyTestFixture.WithTempKeyFile(async file =>
    {
        await SigningKeyTestFixture.WithTempKeyFile(async otherFile =>
        {
            const key = await IdpSigningKey.LoadOrCreate(file);
            const other = await IdpSigningKey.LoadOrCreate(otherFile);
            const token = await key.Sign({ iss: 'x', aud: 'c', sub: 'u' });
            const options = { algorithms: [SigningKeyTestFixture.Algorithm] };
            await assert.rejects(jwtVerify(token, createLocalJWKSet(other.PublicJwks()), options));
            await assert.rejects(jwtVerify(SigningKeyTestFixture.Tamper(token), createLocalJWKSet(key.PublicJwks()), options));
        });
    });
});
