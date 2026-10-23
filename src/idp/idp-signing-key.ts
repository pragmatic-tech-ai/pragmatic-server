import * as fs from 'node:fs';
import * as path from 'node:path';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { SignJWT, calculateJwkThumbprint } from 'jose';
import type { JWK } from 'jose';

/**
 * RS256 signing key for the local OIDC identity provider. The private key is a
 * secret persisted as PEM PKCS8 at a reference path and held only as a node
 * KeyObject (never exported to a JWK); only the public JWK is exposed. The kid is
 * the public JWK thumbprint, so reloading yields the same kid.
 */
export class IdpSigningKey
{
    private static readonly Algorithm = 'RS256';
    private static readonly KeyUse = 'sig';
    private static readonly ModulusLength = 2048;
    private static readonly PrivateKeyMode = 0o600;
    private static readonly FileEncoding = 'utf8';
    private static readonly CreateExclusiveFlag = 'wx';
    private static readonly AlreadyExistsCode = 'EEXIST';
    private static readonly RsaType = 'rsa';
    private static readonly Pkcs8Type = 'pkcs8';
    private static readonly PemFormat = 'pem';
    private static readonly JwkFormat = 'jwk';

    private constructor(
        private readonly privateKey: KeyObject,
        private readonly publicJwk: JWK,
        private readonly kid: string)
    {
    }

    public static async LoadOrCreate(privateKeyFile: string): Promise<IdpSigningKey>
    {
        fs.mkdirSync(path.dirname(privateKeyFile), { recursive: true });
        const pair = generateKeyPairSync(IdpSigningKey.RsaType, { modulusLength: IdpSigningKey.ModulusLength });
        const pem = pair.privateKey.export({ type: IdpSigningKey.Pkcs8Type, format: IdpSigningKey.PemFormat }) as string;
        try
        {
            // Atomic create: fails with EEXIST if a key file is already there.
            fs.writeFileSync(privateKeyFile, pem, { mode: IdpSigningKey.PrivateKeyMode, flag: IdpSigningKey.CreateExclusiveFlag });
        }
        catch (error)
        {
            if ((error as NodeJS.ErrnoException).code !== IdpSigningKey.AlreadyExistsCode)
            {
                throw error;
            }
            const existing = fs.readFileSync(privateKeyFile, IdpSigningKey.FileEncoding);
            return IdpSigningKey.FromPrivateKey(createPrivateKey(existing));
        }
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

    private static async FromPrivateKey(privateKey: KeyObject): Promise<IdpSigningKey>
    {
        const exported = createPublicKey(privateKey).export({ format: IdpSigningKey.JwkFormat });
        const base: JWK = { kty: exported.kty, n: exported.n, e: exported.e };
        const kid = await calculateJwkThumbprint(base);
        const publicJwk: JWK = { ...base, kid, alg: IdpSigningKey.Algorithm, use: IdpSigningKey.KeyUse };
        return new IdpSigningKey(privateKey, publicJwk, kid);
    }
}
