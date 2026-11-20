import { ProblemMapper } from '@pragmatic-tech-ai/pragmatic-app-host'
import { RecordUnstorableError } from './record-map.js'

/**
 * The tenant admin console's domain error -> HTTP status table for the host's ProblemMapper. The tenant API maps its own
 * domain errors to fixed bodies inside its handlers (the engine's text never reaches the wire); what escapes them is a
 * record the store refused (400) or a failure answered as the masked 500, whose detail only reaches the log.
 */
export class TenantConsoleProblems extends ProblemMapper
{
    private static readonly CodeBadRequest = 400
    private static readonly LogPrefix = '[tenant-console] request failed:'

    public constructor(logError: (...items: unknown[]) => void = console.error)
    {
        super(err => logError(TenantConsoleProblems.LogPrefix, err))
        this.Register(RecordUnstorableError, TenantConsoleProblems.CodeBadRequest)
    }
}
