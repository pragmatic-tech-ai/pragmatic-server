import { InternalApiCredential, InternalApiSecretError } from '@pragmatic-tech-ai/pragmatic-app-host'

/** The link's secret file is unusable (missing, unreadable, too short): names the setting and the reason, never the bytes. */
export class InternalApiLinkError extends Error
{
    private static readonly ErrorName = 'InternalApiLinkError'
    private static readonly ReasonSeparator = ': '

    public constructor(setting: string, cause: InternalApiSecretError)
    {
        super(setting + InternalApiLinkError.ReasonSeparator + cause.message, { cause })
        this.name = InternalApiLinkError.ErrorName
    }
}

/**
 * The edge to platform admin console link's credential: pragmatic-app-host's InternalApiCredential with its default
 * label (bit-identical to the copy earlier releases carried), read from the secret file both ends are given.
 */
export class InternalApiLink
{
    /** The file holding the link's shared secret (both ends: the edge and the platform admin console). */
    public static readonly SecretFileEnvVar = 'PRAGMATIC_INTERNAL_API_SECRET_FILE'

    public static Credential(secretFile: string): InternalApiCredential
    {
        try
        {
            return InternalApiCredential.FromFile(secretFile)
        }
        catch (err)
        {
            if (err instanceof InternalApiSecretError)
            {
                throw new InternalApiLinkError(InternalApiLink.SecretFileEnvVar, err)
            }
            throw err
        }
    }
}
