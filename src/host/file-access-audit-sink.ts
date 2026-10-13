import { appendFileSync } from 'node:fs'
import { Action, ResourceKind } from '@pragmatic-tech-ai/todl-identity'
import type { Counter } from '@opentelemetry/api'
import type { IAccessAuditSink, AccessAuditEvent } from './access-audit.js'
import { NullLogger } from '../observability/logger.js'
import type { ILogger } from '../observability/logger.js'

/** Appends one audit line to a path; the default binds node:fs appendFileSync, tests inject a throwing fake. */
export type AuditAppender = (path: string, line: string) => void

/** Appends events as JSON lines to a by-reference path. A write error logs + meters and is swallowed — the
 *  audit trail is best-effort and must never alter a decision or crash a request. */
export class FileAccessAuditSink implements IAccessAuditSink
{
    private static readonly WriteFailed = 'access audit write failed'
    private static readonly SurfaceField = 'surface'
    private static readonly OutcomeField = 'outcome'
    private static readonly SurfaceLabel = 'surface'
    private static readonly Newline = '\n'

    private readonly path: string
    private readonly append: AuditAppender
    private readonly logger: ILogger
    private readonly failures: Counter | undefined

    public constructor(path: string, append: AuditAppender = FileAccessAuditSink.AppendFile, logger: ILogger = new NullLogger(), failures?: Counter)
    {
        this.path = path
        this.append = append
        this.logger = logger
        this.failures = failures
    }

    public Record(event: AccessAuditEvent): Promise<void>
    {
        try
        {
            this.append(this.path, FileAccessAuditSink.Serialize(event) + FileAccessAuditSink.Newline)
        }
        catch
        {
            try
            {
                this.logger.Error(FileAccessAuditSink.WriteFailed, { [FileAccessAuditSink.SurfaceField]: event.Surface, [FileAccessAuditSink.OutcomeField]: event.Outcome })
            }
            catch
            {
                // a broken logger must not turn an audit write-failure into a request failure
            }
            FileAccessAuditSink.Meter(this.failures, event)
        }
        return Promise.resolve()
    }

    private static Meter(failures: Counter | undefined, event: AccessAuditEvent): void
    {
        try
        {
            failures?.add(1, { [FileAccessAuditSink.SurfaceLabel]: event.Surface })
        }
        catch
        {
            // a broken meter must not turn an audit write-failure into a request failure
        }
    }

    private static Serialize(event: AccessAuditEvent): string
    {
        return JSON.stringify({
            timestamp: event.Timestamp.toISOString(),
            tenant: event.TenantId,
            principal: event.PrincipalId,
            surface: event.Surface,
            method: event.MethodOrPath,
            action: event.Action === undefined ? undefined : Action[event.Action],
            resourceKind: event.ResourceKind === undefined ? undefined : ResourceKind[event.ResourceKind],
            resourcePath: event.ResourcePath,
            outcome: event.Outcome,
            reason: event.Reason,
            correlationId: event.CorrelationId,
        })
    }

    private static AppendFile(path: string, line: string): void
    {
        appendFileSync(path, line)
    }
}
