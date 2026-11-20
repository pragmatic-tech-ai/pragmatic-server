import { Server, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { AppHost } from '@pragmatic-tech-ai/pragmatic-app-host'

/** The host offers no node server to hook into (pragmatic-app-host changed its internals): the console refuses to start. */
export class RelayUpgradeHookError extends Error
{
    private static readonly ErrorName = 'RelayUpgradeHookError'
    private static readonly Text = 'The app host exposes no node server to take the desktop relay upgrade from; pragmatic-app-host needs its pre-handshake admission seam.'

    public constructor()
    {
        super(RelayUpgradeHookError.Text)
        this.name = RelayUpgradeHookError.ErrorName
    }
}

/** Answers one upgrade itself, writing its own plain HTTP refusal before any handshake (the desktop relay). */
export interface IRawUpgradeHandler
{
    Upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>
}

/**
 * Takes the upgrades of one exact path off an AppHost's node server before the host's own upgrade dispatch, so their
 * handler can refuse with plain HTTP before the handshake (the Plexus relay reads its refusal statuses). pragmatic-app-host
 * has no seam for that yet (gap recorded in the A4 part 4 plan: `SocketRouteDefinition.Admit`); until it has one, this
 * reads the host's node server, the one non-public member it touches, after Listen, and refuses (RelayUpgradeHookError)
 * when the host has none, so a package change fails loudly at start, never silently. Every other upgrade goes to the
 * host's own listeners unchanged, in order.
 */
export class RelayUpgradeHook
{
    private static readonly ServerMember = 'server'
    private static readonly UpgradeEvent = 'upgrade'
    private static readonly BaseUrl = 'http://localhost'
    private static readonly RootPath = '/'

    public static Install(host: AppHost, path: string, handler: IRawUpgradeHandler): void
    {
        const server = (host as unknown as Record<string, unknown>)[RelayUpgradeHook.ServerMember]
        if (!(server instanceof Server))
        {
            throw new RelayUpgradeHookError()
        }
        const hostListeners = server.listeners(RelayUpgradeHook.UpgradeEvent) as ((req: IncomingMessage, socket: Duplex, head: Buffer) => void)[]
        server.removeAllListeners(RelayUpgradeHook.UpgradeEvent)
        server.on(RelayUpgradeHook.UpgradeEvent, (req: IncomingMessage, socket: Duplex, head: Buffer) =>
        {
            if (RelayUpgradeHook.PathOf(req) === path)
            {
                handler.Upgrade(req, socket, head).catch(() => socket.destroy())
                return
            }
            for (const listener of hostListeners)
            {
                listener.call(server, req, socket, head)
            }
        })
    }

    private static PathOf(req: IncomingMessage): string | undefined
    {
        try
        {
            return new URL(req.url ?? RelayUpgradeHook.RootPath, RelayUpgradeHook.BaseUrl).pathname
        }
        catch
        {
            return undefined
        }
    }
}
