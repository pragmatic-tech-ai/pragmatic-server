import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { IdpSigningKey } from '../idp-signing-key.js';

class SigningKeyTestFixture
{
    public static readonly DirPrefix = 'idp-signing-key-';
    public static readonly KeyFileName = 'idp.pem';

    public static async WithTempKeyFile(body: (file: string) => Promise<void>): Promise<void>
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), SigningKeyTestFixture.DirPrefix));
        try
        {
            await body(path.join(dir, 'nested', SigningKeyTestFixture.KeyFileName));
        }
        finally
        {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
}

test('signs a token verifiable against its own JWKS', async () =>
{
    await SigningKeyTestFixture.WithTempKeyFile(async file =>
    {
        const key = await IdpSigningKey.LoadOrCreate(file);
        const token = await key.Sign({ iss: 'x', aud: 'c', sub: 'u' });
        const result = await jwtVerify(token, createLocalJWKSet(key.PublicJwks()), { algorithms: ['RS256'] });
        assert.equal(result.payload.iss, 'x');
        assert.equal(result.payload.aud, 'c');
        assert.equal(result.payload.sub, 'u');
        assert.equal(result.protectedHeader.kid, key.Kid());
    });
});

test('JWKS entry carries kid, alg RS256, use sig', async () =>
{
    await SigningKeyTestFixture.WithTempKeyFile(async file =>
    {
        const key = await IdpSigningKey.LoadOrCreate(file);
        const jwk = key.PublicJwks().keys[0]!;
        assert.equal(jwk.kid, key.Kid());
        assert.equal(jwk.alg, 'RS256');
        assert.equal(jwk.use, 'sig');
        assert.equal((jwk as Record<string, unknown>)['d'], undefined);
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
