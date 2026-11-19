import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** Raised for an unusable PRAGMATIC_INTERNAL_API_SECRET_FILE. Names the setting and the reason, never the secret. */
export class InternalApiSecretError extends Error
{
    private static readonly ErrorName = 'InternalApiSecretError'

    public constructor(reason: string)
    {
        super(InternalApiCredential.SecretFileEnvVar + InternalApiCredential.ReasonSeparator + reason)
        this.name = InternalApiSecretError.ErrorName
    }
}

/**
 * The edge's identity towards admin's internal API. Both sides read the same shared secret file (a Podman secret); the
 * bearer on the wire is HMAC-SHA256(secret, a fixed label), so the secret itself never travels. Comparison HMACs the
 * presented value too, so the timing never depends on its length or content.
 */
export class InternalApiCredential
{
    public static readonly SecretFileEnvVar = 'PRAGMATIC_INTERNAL_API_SECRET_FILE'
    public static readonly ReasonSeparator = ': '
    private static readonly Label = 'pragmatic-internal-api/v1'
    private static readonly CompareLabel = 'pragmatic-internal-api/compare'
    private static readonly Algorithm = 'sha256'
    private static readonly Encoding = 'base64url'
    private static readonly MinSecretBytes = 32
    private static readonly Unreadable = 'file is missing or unreadable'
    private static readonly TooShort = 'secret must be at least 32 bytes'

    private readonly bearer: string

    private constructor(private readonly secret: Buffer)
    {
        this.bearer = createHmac(InternalApiCredential.Algorithm, secret).update(InternalApiCredential.Label).digest(InternalApiCredential.Encoding)
    }

    public static FromFile(path: string): InternalApiCredential
    {
        let secret: Buffer
        try
        {
            secret = readFileSync(path)
        }
        catch
        {
            throw new InternalApiSecretError(InternalApiCredential.Unreadable)
        }
        if (secret.length < InternalApiCredential.MinSecretBytes)
        {
            throw new InternalApiSecretError(InternalApiCredential.TooShort)
        }
        return new InternalApiCredential(secret)
    }

    public Bearer(): string
    {
        return this.bearer
    }

    public Matches(presented: string): boolean
    {
        return timingSafeEqual(this.Digest(presented), this.Digest(this.bearer))
    }

    private Digest(value: string): Buffer
    {
        return createHmac(InternalApiCredential.Algorithm, this.secret).update(InternalApiCredential.CompareLabel).update(value).digest()
    }
}
