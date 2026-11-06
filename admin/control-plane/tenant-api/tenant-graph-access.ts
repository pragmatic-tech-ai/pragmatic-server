import type { AuditRegistry } from '../audit-record.js'
import { AdminProxyError, AdminProxyErrorKind } from '../admin-proxy.js'
import type { IGraphService } from '../control-plane-host.js'
import { EnvironmentUnreachableError } from '../environment-endpoints.js'
import { EnvironmentNotDevelopmentError, EnvironmentNotFoundError } from '../environment-service.js'
import { GraphExistsError, GraphNameInvalidError, GraphNotFoundError } from '../graph-service.js'
import { PlaneHttp } from '../plane-http.js'
import { TransportFailure } from '../transport-failure.js'
import { TenantAuditEntry } from '../tenant-auth/tenant-audit-entry.js'
import type { TenantSession } from '../tenant-auth/tenant-session.js'

/** What a graph operation's failure was; StatusOf and MessageOf each map it to the wire. */
enum GraphFailureKind
{
    Exists = 'exists',
    GraphMissing = 'graph-missing',
    EnvironmentMissing = 'environment-missing',
    NameInvalid = 'name-invalid',
    NotDevelopment = 'not-development',
    Unreachable = 'unreachable',
    Failed = 'failed',
}

/**
 * What the tenant API's graph routes need: the graph service (undefined when this composition cannot reach its
 * environments, so the routes answer 503 with a sentence) and the audit log graph writes are recorded in. Also the one
 * home of the routes' fixed error table: a caught error's own text (hosts, names) never reaches the wire.
 */
export class TenantGraphAccess
{
    public static readonly NotDevelopmentMessage = 'Graphs exist only in Development environments.'
    public static readonly UnreachableMessage = 'This console cannot reach its environments, so graphs are unavailable here.'
    public static readonly FieldsMessage = 'name (non-empty string) is required; description must be a string'
    public static readonly ExistsMessage = 'A graph with that name already exists in this environment.'
    public static readonly NotFoundMessage = 'That graph does not exist in this environment.'
    public static readonly NameInvalidMessage = 'Use lowercase letters, digits and hyphens, starting with a letter or digit.'
    public static readonly ConnectMessage = 'The environment could not be reached. Check that it is running.'
    public static readonly FailedMessage = 'The graph operation failed.'
    private static readonly Statuses: Readonly<Record<GraphFailureKind, number>> = {
        [GraphFailureKind.Exists]: 409,
        [GraphFailureKind.GraphMissing]: 404,
        [GraphFailureKind.EnvironmentMissing]: 404,
        [GraphFailureKind.NameInvalid]: 400,
        [GraphFailureKind.NotDevelopment]: 400,
        [GraphFailureKind.Unreachable]: 503,
        [GraphFailureKind.Failed]: 500,
    }
    private static readonly Messages: Readonly<Record<GraphFailureKind, string>> = {
        [GraphFailureKind.Exists]: TenantGraphAccess.ExistsMessage,
        [GraphFailureKind.GraphMissing]: TenantGraphAccess.NotFoundMessage,
        // The tenant API's generic 404 body: an environment that vanished between the ownership check and the call.
        [GraphFailureKind.EnvironmentMissing]: PlaneHttp.NotFoundMessage,
        [GraphFailureKind.NameInvalid]: TenantGraphAccess.NameInvalidMessage,
        [GraphFailureKind.NotDevelopment]: TenantGraphAccess.NotDevelopmentMessage,
        [GraphFailureKind.Unreachable]: TenantGraphAccess.ConnectMessage,
        [GraphFailureKind.Failed]: TenantGraphAccess.FailedMessage,
    }
    private static readonly EnvironmentNote = 'environment='
    private static readonly GraphNote = ' graph='

    public constructor(private readonly graphs: IGraphService | undefined, private readonly audit: AuditRegistry)
    {
    }

    /** The graph service; undefined means this composition cannot reach its environments. */
    public get Service(): IGraphService | undefined
    {
        return this.graphs
    }

    /** Records one graph write with its final status; best effort, never throws (a failure logs the error's name only). */
    public async Record(session: TenantSession, method: string, path: string, status: number, environment: string, graph: string): Promise<void>
    {
        const note = TenantGraphAccess.EnvironmentNote + environment + TenantGraphAccess.GraphNote + graph
        await TenantAuditEntry.AppendBestEffort(this.audit, { actor: TenantAuditEntry.ActorOf(session), method, path, status, note })
    }

    public static StatusOf(err: unknown): number
    {
        return TenantGraphAccess.Statuses[TenantGraphAccess.KindOf(err)]
    }

    public static MessageOf(err: unknown): string
    {
        return TenantGraphAccess.Messages[TenantGraphAccess.KindOf(err)]
    }

    /** The one error-to-kind chain both StatusOf and MessageOf read, so a status and its sentence can never drift apart. */
    private static KindOf(err: unknown): GraphFailureKind
    {
        if (err instanceof GraphExistsError)
        {
            return GraphFailureKind.Exists
        }
        if (err instanceof GraphNotFoundError)
        {
            return GraphFailureKind.GraphMissing
        }
        if (err instanceof EnvironmentNotFoundError)
        {
            return GraphFailureKind.EnvironmentMissing
        }
        if (err instanceof GraphNameInvalidError)
        {
            return GraphFailureKind.NameInvalid
        }
        if (err instanceof EnvironmentNotDevelopmentError)
        {
            return GraphFailureKind.NotDevelopment
        }
        if (TenantGraphAccess.IsUnreachable(err))
        {
            return GraphFailureKind.Unreachable
        }
        return GraphFailureKind.Failed
    }

    /**
     * The environment could not be reached: the admin dial failed, or a failure before it (the environment has no
     * reachable endpoint, or its lease dial failed at the TCP level).
     */
    private static IsUnreachable(err: unknown): boolean
    {
        if (err instanceof AdminProxyError)
        {
            return err.Kind === AdminProxyErrorKind.Connect || err.IsTransport
        }
        return err instanceof EnvironmentUnreachableError || TransportFailure.Is(err)
    }
}
