import type { AgentChannelReply, AgentChannelRequest, IAgentChannelBackend } from './agent-channel-backend.js'
import type { InternalApiClient } from './internal-api-client.js'
import { InternalApiRoutes } from './internal-api-routes.js'

/** The edge's agent channel: every call goes to admin's internal API, which verifies the hive's bearer and answers;
 *  the edge holds no registry, token hash or key. Admin unreachable or malformed = 503, never admin's text. */
export class RemoteAgentChannelBackend implements IAgentChannelBackend
{
    public static readonly UnavailableReply: AgentChannelReply = { Status: 503, Body: { error: 'unavailable' } }

    /** servesConsole mirrors the admin this edge fronts; a deployed admin always serves the console routes. */
    public constructor(private readonly client: InternalApiClient, private readonly servesConsole: boolean = true)
    {
    }

    public ServesConsole(): boolean
    {
        return this.servesConsole
    }

    public async Handle(request: AgentChannelRequest): Promise<AgentChannelReply>
    {
        try
        {
            const reply = await this.client.Post<AgentChannelReply>(InternalApiRoutes.Agent, request)
            return RemoteAgentChannelBackend.IsReply(reply) ? reply : RemoteAgentChannelBackend.UnavailableReply
        }
        catch
        {
            return RemoteAgentChannelBackend.UnavailableReply
        }
    }

    public static IsReply(reply: unknown): reply is AgentChannelReply
    {
        const status = (reply as { Status?: unknown } | null)?.Status
        return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    }
}
