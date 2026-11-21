import { type DiscoveryReply, type IDesktopDiscoveryBackend, type InternalApiClient, InternalApiRoutes } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { RemoteAgentChannelBackend } from './remote-agent-channel-backend.js'

/** The edge's desktop discovery: matching runs on admin (the fingerprint keys are sealed under its master key).
 *  Admin unreachable or malformed = 503 `unavailable`. */
export class RemoteDesktopDiscoveryBackend implements IDesktopDiscoveryBackend
{
    private static readonly UnavailableReply: DiscoveryReply = { Status: RemoteAgentChannelBackend.UnavailableStatus, Body: RemoteAgentChannelBackend.UnavailableBody }
    private static readonly EmailField = 'email'

    public constructor(private readonly client: InternalApiClient)
    {
    }

    public async Discover(email: string): Promise<DiscoveryReply>
    {
        try
        {
            const reply = await this.client.Post<DiscoveryReply>(InternalApiRoutes.Discover, { [RemoteDesktopDiscoveryBackend.EmailField]: email })
            return RemoteAgentChannelBackend.IsReply(reply) ? reply : RemoteDesktopDiscoveryBackend.UnavailableReply
        }
        catch
        {
            return RemoteDesktopDiscoveryBackend.UnavailableReply
        }
    }
}
