import { AuditEvent, AuditEventKind, Action, ResourceKind } from '@pragmatic-tech-ai/todl-identity'
import type { IAuditSink } from '@pragmatic-tech-ai/todl-identity'
import { AuditSurface } from './access-audit.js'
import type { IAccessAuditSink, AccessAuditEvent } from './access-audit.js'
import { NullLogger } from '../observability/logger.js'
import type { ILogger } from '../observability/logger.js'

/** Bridges a server AccessAuditEvent onto the cloud identity SqlAuditStore (IAuditSink). Present only in cloud
 *  mode; a store failure logs and is swallowed so it never alters a decision. */
export class SqlAuditAccessSink implements IAccessAuditSink
{
    private static readonly WriteFailed = 'access audit sql write failed'
    private static readonly SurfaceKey = 'surface'
    private static readonly MethodKey = 'method'
    private static readonly ActionKey = 'action'
    private static readonly ResourceKindKey = 'resourceKind'
    private static readonly ResourcePathKey = 'resourcePath'
    private static readonly OutcomeKey = 'outcome'
    private static readonly ReasonKey = 'reason'
    private static readonly CorrelationKey = 'correlationId'
    private static readonly SurfaceField = 'surface'

    private readonly store: IAuditSink
    private readonly logger: ILogger

    public constructor(store: IAuditSink, logger: ILogger = new NullLogger())
    {
        this.store = store
        this.logger = logger
    }

    public async Record(event: AccessAuditEvent): Promise<void>
    {
        try
        {
            await this.store.Record(new AuditEvent(SqlAuditAccessSink.KindOf(event), event.TenantId, event.PrincipalId ?? null, event.Timestamp, SqlAuditAccessSink.DetailOf(event)))
        }
        catch
        {
            try
            {
                this.logger.Error(SqlAuditAccessSink.WriteFailed, { [SqlAuditAccessSink.SurfaceField]: event.Surface })
            }
            catch
            {
                // a broken logger must not turn an audit write-failure into a request failure
            }
        }
    }

    private static KindOf(event: AccessAuditEvent): AuditEventKind
    {
        return event.Surface === AuditSurface.Http ? AuditEventKind.Authentication : AuditEventKind.AccessDecision
    }

    private static DetailOf(event: AccessAuditEvent): ReadonlyMap<string, string>
    {
        const detail = new Map<string, string>()
        detail.set(SqlAuditAccessSink.SurfaceKey, event.Surface)
        detail.set(SqlAuditAccessSink.MethodKey, event.MethodOrPath)
        detail.set(SqlAuditAccessSink.OutcomeKey, event.Outcome)
        if (event.Action !== undefined)
        {
            detail.set(SqlAuditAccessSink.ActionKey, Action[event.Action])
        }
        if (event.ResourceKind !== undefined)
        {
            detail.set(SqlAuditAccessSink.ResourceKindKey, ResourceKind[event.ResourceKind])
        }
        if (event.ResourcePath !== undefined)
        {
            detail.set(SqlAuditAccessSink.ResourcePathKey, event.ResourcePath)
        }
        if (event.Reason !== undefined)
        {
            detail.set(SqlAuditAccessSink.ReasonKey, event.Reason)
        }
        if (event.CorrelationId !== undefined)
        {
            detail.set(SqlAuditAccessSink.CorrelationKey, event.CorrelationId)
        }
        return detail
    }
}
