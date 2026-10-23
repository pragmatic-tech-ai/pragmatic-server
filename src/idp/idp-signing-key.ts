import * as fs from 'node:fs';
import * as path from 'node:path';
import { SignJWT, calculateJwkThumbprint, exportJWK, exportPKCS8, generateKeyPair, importPKCS8 } from 'jose';
import type { JWK } from 'jose';

/**
 * RS256 signing key for the local OIDC identity provider. The private key is a
 * secret persisted as PEM PKCS8 at a reference path; only the public JWK is ever
 * exposed. The kid is the public JWK thumbprint, so reloading yields the same kid.
 */
export class IdpSigningKey
{
    private static readonly Algorithm = 'RS256';
    private static readonly KeyUse = 'sig';
    private static readonly ModulusLength = 2048;
    private static readonly PrivateKeyMode = 0o600;
    private static readonly FileEncoding = 'utf8';

    private constructor(
        private readonly privateKey: CryptoKey,
        private readonly publicJwk: JWK,
        private readonly kid: string)
    {
    }

    public static async LoadOrCreate(privateKeyFile: string): Promise<IdpSigningKey>
    {
        if (fs.existsSync(privateKeyFile))
        {
            const pem = fs.readFileSync(privateKeyFile, IdpSigningKey.FileEncoding);
            const privateKey = await importPKCS8(pem, IdpSigningKey.Algorithm, { extractable: true });
            return IdpSigningKey.FromPrivateKey(privateKey);
        }

        const pair = await generateKeyPair(IdpSigningKey.Algorithm, {
            modulusLength: IdpSigningKey.ModulusLength,
            extractable: true,
        });
        const pem = await exportPKCS8(pair.privateKey);
        fs.mkdirSync(path.dirname(privateKeyFile), { recursive: true });
        fs.writeFileSync(privateKeyFile, pem, { mode: IdpSigningKey.PrivateKeyMode });
        return IdpSigningKey.FromPrivateKey(pair.privateKey);
    }

    public PublicJwks(): { keys: JWK[] }
    {
        return { keys: [{ ...this.publicJwk }] };
    }

    public Kid(): string
    {
        return this.kid;
    }

    public async Sign(claims: Record<string, unknown>): Promise<string>
    {
        return new SignJWT(claims)
            .setProtectedHeader({ alg: IdpSigningKey.Algorithm, kid: this.kid })
            .sign(this.privateKey);
    }

    private static async FromPrivateKey(privateKey: CryptoKey): Promise<IdpSigningKey>
    {
        // Strip private members (d, p, q, dp, dq, qi) so only the public part is exposed.
        const full = await exportJWK(privateKey);
        const base: JWK = { kty: full.kty, n: full.n, e: full.e };
        const kid = await calculateJwkThumbprint(base);
        const publicJwk: JWK = { ...base, kid, alg: IdpSigningKey.Algorithm, use: IdpSigningKey.KeyUse };
        return new IdpSigningKey(privateKey, publicJwk, kid);
    }
}
