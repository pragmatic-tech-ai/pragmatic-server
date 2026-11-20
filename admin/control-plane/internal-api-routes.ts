/** The internal API's routes (admin listens, the edge calls). Version-prefixed so both sides can evolve together. */
export class InternalApiRoutes
{
    /** POST: body = AgentChannelRequest, reply = AgentChannelReply. */
    public static readonly Agent = '/internal/v1/agent'
    /** POST: body = { email }, reply = DiscoveryReply. */
    public static readonly Discover = '/internal/v1/desktop/discover'
    /** GET, no auth: liveness. */
    public static readonly Healthz = '/internal/v1/healthz'
}
