import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import type { IKeyStore } from './key-store.js'

/** Fixed message only; never carries key material, signature bytes, or identity values. */
export class UiSignatureError extends Error
{
    public static readonly SafeMessage = 'ui artifact signature verification failed'
    private static readonly ErrorName = 'UiSignatureError'

    public constructor()
    {
        super(UiSignatureError.SafeMessage)
        this.name = UiSignatureError.ErrorName
    }
}

/** Produces a detached Ed25519 signature binding an app's name, version and manifest digest. */
export class UiArtifactSigner
{
    private static readonly Base64 = 'base64'

    public constructor(private readonly keys: IKeyStore)
    {
    }

    /** The single definition of the signed payload; Verify reuses it so the two cannot diverge. */
    public static CanonicalPayload(appName: string, appVersion: string, manifestDigest: string): string
    {
        return JSON.stringify([appName, appVersion, manifestDigest])
    }

    public async Sign(appName: string, appVersion: string, manifestDigest: string, signingKeyRef: string): Promise<string>
    {
        const pem = await this.keys.PrivateKey(signingKeyRef)
        const payload = Buffer.from(UiArtifactSigner.CanonicalPayload(appName, appVersion, manifestDigest))
        return sign(null, payload, createPrivateKey(pem)).toString(UiArtifactSigner.Base64)
    }
}

/** Verifies a detached UI-artifact signature against the trust-root public key; fails closed. */
export class UiArtifactVerifier
{
    private static readonly Base64 = 'base64'

    public constructor(private readonly keys: IKeyStore)
    {
    }

    public async Verify(
        appName: string,
        appVersion: string,
        manifestDigest: string,
        signatureBase64: string,
        trustRootRef: string | undefined,
    ): Promise<void>
    {
        if (trustRootRef === undefined || trustRootRef.length === 0)
        {
            throw new UiSignatureError()
        }
        let valid = false
        try
        {
            const pem = await this.keys.PublicKey(trustRootRef)
            const payload = Buffer.from(UiArtifactSigner.CanonicalPayload(appName, appVersion, manifestDigest))
            valid = verify(null, payload, createPublicKey(pem), Buffer.from(signatureBase64, UiArtifactVerifier.Base64))
        }
        catch
        {
            valid = false
        }
        if (!valid)
        {
            throw new UiSignatureError()
        }
    }
}
