import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { TenantApiError } from './tenant-api-client.js'
import type { ConnectionStatus, HiveRolloutDto, IConnectionSource } from './tenant-types.js'

export enum ConnectionState
{
    Loading,
    Connected,
    Quiet,
    NoHive,
    Error,
    Forbidden,
}

// Presentation-agnostic state for the read-only Connection status page. Honest: a 503 from the
// rollout probe means the hive is quiet (not reachable right now), reported as Quiet, not Error.
export class ConnectionStatusViewModel extends Observable
{
    public static readonly StateProperty = 'State'
    public static readonly StatusProperty = 'Status'
    public static readonly ErrorProperty = 'Error'

    private static readonly NoMessage = ''
    private static readonly ConnectedDetail = 'The hive answered the rollout probe: Pragmatic is reachable.'
    private static readonly QuietDetail = 'The hive did not answer the rollout probe (service unavailable): Pragmatic is not reachable right now.'

    private state = ConnectionState.Loading
    private status: ConnectionStatus | undefined
    private error = ConnectionStatusViewModel.NoMessage
    private loadToken = 0

    public constructor(private readonly source: IConnectionSource)
    {
        super()
    }

    public get State(): ConnectionState
    {
        return this.state
    }

    public get Status(): ConnectionStatus | undefined
    {
        return this.status
    }

    public get Error(): string
    {
        return this.error
    }

    public async Load(): Promise<void>
    {
        const token = ++this.loadToken
        this.SetError(ConnectionStatusViewModel.NoMessage)
        this.SetState(ConnectionState.Loading)
        try
        {
            const hives = await this.source.ListHives()
            if (token !== this.loadToken)
            {
                return
            }
            if (hives.length === 0)
            {
                this.SetStatus(undefined)
                this.SetError(ConnectionStatusViewModel.NoMessage)
                this.SetState(ConnectionState.NoHive)
                return
            }
            // A tenant has exactly one hive (same resolution as Overview/Releases).
            const rollout = await this.source.GetRollout(hives[0].id)
            if (token !== this.loadToken)
            {
                return
            }
            this.SetStatus(ConnectionStatusViewModel.Connected(rollout))
            this.SetError(ConnectionStatusViewModel.NoMessage)
            this.SetState(ConnectionState.Connected)
        }
        catch (e)
        {
            if (ConnectionStatusViewModel.IsUnauthorized(e))
            {
                throw e
            }
            if (token !== this.loadToken)
            {
                return
            }
            this.Fail(e)
        }
    }

    private Fail(e: unknown): void
    {
        if (ConnectionStatusViewModel.IsQuiet(e))
        {
            this.SetStatus({ reachable: false, detail: ConnectionStatusViewModel.QuietDetail, targetVersion: undefined, environments: [] })
            this.SetError(ConnectionStatusViewModel.NoMessage)
            this.SetState(ConnectionState.Quiet)
        }
        else if (ConnectionStatusViewModel.IsForbidden(e))
        {
            this.SetStatus(undefined)
            this.SetError(ConnectionStatusViewModel.NoMessage)
            this.SetState(ConnectionState.Forbidden)
        }
        else
        {
            this.SetStatus(undefined)
            this.SetError(e instanceof Error ? e.message : String(e))
            this.SetState(ConnectionState.Error)
        }
    }

    private static Connected(rollout: HiveRolloutDto): ConnectionStatus
    {
        return {
            reachable: true,
            detail: ConnectionStatusViewModel.ConnectedDetail,
            targetVersion: rollout.targetVersion,
            environments: rollout.environments.map(e => ({ name: e.environmentName, runningImage: e.runningImage, ready: e.ready }))
        }
    }

    // A 401 is not a displayable error: it propagates so the view can route to login.
    private static IsUnauthorized(e: unknown): boolean
    {
        return e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus
    }

    private static IsForbidden(e: unknown): boolean
    {
        return e instanceof TenantApiError && e.Status === TenantApiError.ForbiddenStatus
    }

    private static IsQuiet(e: unknown): boolean
    {
        return e instanceof TenantApiError && e.Status === TenantApiError.UnavailableStatus
    }

    private SetStatus(value: ConnectionStatus | undefined): void
    {
        const old = this.status
        this.status = value
        this.RaisePropertyChanged(ConnectionStatusViewModel.StatusProperty, old, value)
    }

    private SetError(value: string): void
    {
        const old = this.error
        this.error = value
        this.RaisePropertyChanged(ConnectionStatusViewModel.ErrorProperty, old, value)
    }

    private SetState(value: ConnectionState): void
    {
        const old = this.state
        this.state = value
        this.RaisePropertyChanged(ConnectionStatusViewModel.StateProperty, old, value)
    }
}
