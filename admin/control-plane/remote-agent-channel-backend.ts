import { type AgentChannelReply, type AgentChannelRequest, type IAgentChannelBackend, type InternalApiClient, InternalApiRoutes } from '@pragmatic-tech-ai/pragmatic-platform-link'

/** The edge's agent channel: every call goes to admin's internal API, which verifies the hive's bearer and answers;
 *  the edge holds no registry, token hash or key. Admin unreachable or malformed = 503, never admin's text. */
export class RemoteAgentChannelBackend implements IAgentChannelBackend
{
    /** The one body the edge answers when admin can't: shared by every remote backend. */
    public static readonly UnavailableBody = { error: 'unavailable' }
    public static readonly UnavailableStatus = 503
    public static readonly UnavailableReply: AgentChannelReply = { Status: RemoteAgentChannelBackend.UnavailableStatus, Body: RemoteAgentChannelBackend.UnavailableBody }

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
