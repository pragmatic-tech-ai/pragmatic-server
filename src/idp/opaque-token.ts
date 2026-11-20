import { createHash, randomBytes } from 'node:crypto';

/** The service's opaque bearer values (authorization codes, SSO session ids, refresh tokens): random, and stored only
 *  as their SHA-256 digest, so a database read reveals none that still works. */
export class OpaqueToken
{
    public static readonly DefaultBytes = 32;
    private static readonly Encoding = 'base64url';
    private static readonly HashAlgorithm = 'sha256';
    private static readonly HashEncoding = 'hex';

    public static New(bytes: number = OpaqueToken.DefaultBytes): string
    {
        return randomBytes(bytes).toString(OpaqueToken.Encoding);
    }

    public static Hash(token: string): string
    {
        return createHash(OpaqueToken.HashAlgorithm).update(token).digest(OpaqueToken.HashEncoding);
    }
}
