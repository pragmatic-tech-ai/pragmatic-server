/** A discovery answer: HTTP status plus JSON body. */
export interface DiscoveryReply
{
    Status: number
    Body: unknown
}

/** Answers "which tenant(s) does this email belong to": in-process over the platform records (all, admin), or remote
 *  over admin's internal API (edge). Origin, size and throttle checks happen before, in DesktopDiscoveryEndpoint. */
export interface IDesktopDiscoveryBackend
{
    Discover(email: string): Promise<DiscoveryReply>
}
