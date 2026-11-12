import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'

/** Ed25519 over the UTF-8 bytes of an image digest string, base64 (the CryptoImageVerifier scheme). */
export class ReleaseSignature
{
    private static readonly Base64 = 'base64'

    public static Sign(digest: string, privateKeyPem: string): string
    {
        return sign(null, Buffer.from(digest), createPrivateKey(privateKeyPem)).toString(ReleaseSignature.Base64)
    }

    public static Verifies(digest: string, signature: string, publicKeyPem: string): boolean
    {
        try
        {
            return verify(null, Buffer.from(digest), createPublicKey(publicKeyPem), Buffer.from(signature, ReleaseSignature.Base64))
        }
        catch
        {
            return false
        }
    }
}
