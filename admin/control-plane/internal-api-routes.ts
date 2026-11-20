import { InternalApiCredential, InternalApiSecretError } from '@pragmatic-tech-ai/pragmatic-app-host'

/** The internal API's routes (admin listens, the edge calls). Version-prefixed so both sides can evolve together. */
export class InternalApiRoutes
{
    /** The file holding the link's shared secret (both ends: the edge and the platform admin console). */
    public static readonly SecretFileEnvVar = 'PRAGMATIC_INTERNAL_API_SECRET_FILE'
    private static readonly ReasonSeparator = ': '
    /** POST: body = AgentChannelRequest, reply = AgentChannelReply. */
    public static readonly Agent = '/internal/v1/agent'
    /** POST: body = { email }, reply = DiscoveryReply. */
    public static readonly Discover = '/internal/v1/desktop/discover'
    /** GET, no auth: liveness. */
    public static readonly Healthz = '/internal/v1/healthz'

    /** The link credential from the secret file (app-host's, default label); a refusal names the setting, never the bytes. */
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
                throw new InternalApiSecretError(InternalApiRoutes.SecretFileEnvVar + InternalApiRoutes.ReasonSeparator + err.message)
            }
            throw err
        }
    }
}
