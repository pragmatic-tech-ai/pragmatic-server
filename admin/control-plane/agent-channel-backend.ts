/** The agent channel's eight operations, named by their route segment under /agent/hives/<id>/. */
export enum AgentChannelOperation
{
    Target = 'target',
    Snapshot = 'snapshot',
    Adoptable = 'adoptable',
    Status = 'status',
    Adopt = 'adopt',
    Ledger = 'ledger',
    Console = 'console',
    ConsoleVerifyDomain = 'console/verify-domain',
}

/** One authenticated agent-channel call, after the HTTP layer checked the route, method, hive id and body size.
 *  Body is the raw request text (POST routes), so every parse error keeps its exact wording wherever it is handled. */
export interface AgentChannelRequest
{
    Operation: AgentChannelOperation
    HiveId: string
    Token: string
    Body?: string
    Query?: Record<string, string>
}

/** The HTTP answer: Status plus the JSON body the route sends, or no body (204). */
export interface AgentChannelReply
{
    Status: number
    Body?: unknown
}

/** What answers agent-channel calls: in-process over the platform registries (all, admin), or remote over admin's
 *  internal API (edge). Both give byte-identical replies. */
export interface IAgentChannelBackend
{
    Handle(request: AgentChannelRequest): Promise<AgentChannelReply>
    /** Whether the console routes (console, console/verify-domain) are served at all. */
    ServesConsole(): boolean
}
