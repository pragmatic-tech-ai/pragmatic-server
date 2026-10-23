import { WebSocket } from 'ws'
import type { IEnvironmentService } from '../control-plane-host.js'
import type { ILogProcess } from '../../../environments/seed/docker.js'
import type { TenantSession } from '../tenant-auth/tenant-session.js'

/**
 * Serves a single tenant log-follow websocket. Given an already-gated session, the host keeps its upgrade handler
 * thin by handing the open socket here: this class verifies the environment belongs to the session's tenant (the
 * 404-equivalent is a close, with NO stream started otherwise), starts the `docker logs -f` stream forwarding each
 * chunk to the socket, and kills that process exactly once when the socket closes or errors. No secret is ever sent.
 */
export class TenantLogSocket
{
    private static readonly CloseEvent = 'close'
    private static readonly ErrorEvent = 'error'

    private process: ILogProcess | undefined
    private killed = false

    public constructor(
        private readonly session: TenantSession,
        private readonly environmentName: string,
        private readonly service: IEnvironmentService)
    {
    }

    /**
     * Starts forwarding logs when the env belongs to the session's tenant (returns true); otherwise closes the socket
     * and returns false WITHOUT starting any stream. On success the socket's close/error tears the process down.
     */
    public Attach(ws: WebSocket): boolean
    {
        const owned = this.service.List().find(r => r.name === this.environmentName && r.tenantId === this.session.tenantId)
        if (owned === undefined)
        {
            ws.close()
            return false
        }
        this.process = this.service.LogStream(this.environmentName, chunk =>
        {
            if (ws.readyState === WebSocket.OPEN)
            {
                ws.send(chunk)
            }
        })
        ws.on(TenantLogSocket.CloseEvent, () => this.Dispose())
        ws.on(TenantLogSocket.ErrorEvent, () => this.Dispose())
        return true
    }

    /** Kills the log-follow process exactly once; safe to call repeatedly and from the host's Close() teardown. */
    public Dispose(): void
    {
        if (this.killed)
        {
            return
        }
        this.killed = true
        this.process?.Kill()
    }
}
