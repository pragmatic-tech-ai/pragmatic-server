import type { IncomingMessage } from 'node:http'
import type { ServerIdentityPack } from '@pragmatic-tech-ai/todl-identity-node'
import type { BrowserSessionAuth } from '../browser-session-auth.js'

/** Whether a request carries a live browser session for an environment (AppServingEndpoint asks before serving an app's page). */
export interface IAppSessionCheck
{
    HasSession(req: IncomingMessage, environment: string): Promise<boolean>
}

/** The slice of a per-environment server the check needs: its id and its identity pack (the session store). */
export interface ISessionServer
{
    Tenant(): { Id: string }
    Pack(): Promise<ServerIdentityPack>
}

/** Resolves an environment id to its server; the host registry satisfies this. Rejects for an unknown environment. */
export interface ISessionServerResolver
{
    ServerFor(environment: string): Promise<ISessionServer>
}

/**
 * The host's check: the session cookie names this environment and its token is a live session of it. A page load is a
 * plain navigation, so no Origin header is required (the WebSocket the page then opens still requires one).
 */
export class CookieAppSessionCheck implements IAppSessionCheck
{
    public constructor(private readonly browser: BrowserSessionAuth, private readonly servers: ISessionServerResolver)
    {
    }

    public async HasSession(req: IncomingMessage, environment: string): Promise<boolean>
    {
        const credential = this.browser.Credential(req, false)
        if (credential === null || credential.Tenant !== environment)
        {
            return false
        }
        const server = await this.servers.ServerFor(environment)
        const session = await (await server.Pack()).Sessions.Validate(credential.Token)
        return session !== null && session.TenantId === server.Tenant().Id
    }
}
