import type { AuditRegistry } from '../audit-record.js'
import { AdminProxyError, AdminProxyErrorKind } from '../admin-proxy.js'
import type { IGraphService } from '../control-plane-host.js'
import { EnvironmentNotDevelopmentError, EnvironmentNotFoundError } from '../environment-service.js'
import { GraphExistsError, GraphNameInvalidError, GraphNotFoundError } from '../graph-service.js'
import { TenantAuditEntry } from '../tenant-auth/tenant-audit-entry.js'
import type { TenantSession } from '../tenant-auth/tenant-session.js'

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
    /** The tenant API's generic 404 body (an environment that vanished between the ownership check and the call). */
    public static readonly EnvironmentNotFoundMessage = 'Not found'
    private static readonly StatusBadRequest = 400
    private static readonly StatusNotFound = 404
    private static readonly StatusConflict = 409
    private static readonly StatusInternal = 500
    private static readonly StatusUnavailable = 503
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
        const C = TenantGraphAccess
        if (err instanceof GraphExistsError)
        {
            return C.StatusConflict
        }
        if (err instanceof GraphNotFoundError || err instanceof EnvironmentNotFoundError)
        {
            return C.StatusNotFound
        }
        if (err instanceof GraphNameInvalidError || err instanceof EnvironmentNotDevelopmentError)
        {
            return C.StatusBadRequest
        }
        if (err instanceof AdminProxyError && err.Kind === AdminProxyErrorKind.Connect)
        {
            return C.StatusUnavailable
        }
        return C.StatusInternal
    }

    public static MessageOf(err: unknown): string
    {
        const C = TenantGraphAccess
        if (err instanceof GraphExistsError)
        {
            return C.ExistsMessage
        }
        if (err instanceof GraphNotFoundError)
        {
            return C.NotFoundMessage
        }
        if (err instanceof EnvironmentNotFoundError)
        {
            return C.EnvironmentNotFoundMessage
        }
        if (err instanceof GraphNameInvalidError)
        {
            return C.NameInvalidMessage
        }
        if (err instanceof EnvironmentNotDevelopmentError)
        {
            return C.NotDevelopmentMessage
        }
        if (err instanceof AdminProxyError && err.Kind === AdminProxyErrorKind.Connect)
        {
            return C.ConnectMessage
        }
        return C.FailedMessage
    }
}
