import type { Cypher } from '@pragmatic-tech-ai/graph'
import type { CypherExecuteResultDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { StructuredLogger } from '../../observability/logger.js'
import type { ILogger } from '../../observability/logger.js'

/** A validated cypher/execute request, free of wire concerns (the handler converts the parameters once). */
export interface ICypherExecuteRequest
{
    cypher: string
    parameters: ReadonlyMap<string, Cypher.ParameterValue>
    expectedRevision?: number
    timeoutMs: number
    maxVarLength: number
}

/**
 * The `cypher/execute` endpoint's engine side, for any engine host (ruling S1: dev DevCypherExecute, runtime
 * EnvironmentCypherExecute). `modelId` confines the write to one model; dev requires it, runtime takes it optionally.
 */
export interface IGraphCypherExecute
{
    Run(context: AccessContext, modelId: string | undefined, request: ICypherExecuteRequest): Promise<CypherExecuteResultDto>
}

/** Where an execute reports a failure after its write committed (the write is applied; only its rows or revision read failed). */
export interface IExecuteDiagnostics
{
    AfterCommitFailed(error: unknown): void
}

/** Reports each after-commit failure as one warning on the server logger, by error name only (messages can carry paths). */
export class LoggerExecuteDiagnostics implements IExecuteDiagnostics
{
    private static readonly Line = 'cypher/execute committed, but reading its result failed: '
    private static readonly UnknownName = 'UnknownError'

    public constructor(private readonly logger: ILogger = StructuredLogger.ToStdout())
    {
    }

    public AfterCommitFailed(error: unknown): void
    {
        this.logger.Warn(LoggerExecuteDiagnostics.Line + (error instanceof Error ? error.name : LoggerExecuteDiagnostics.UnknownName))
    }
}

/** One execute attempt's outcome: the wire result, or that the engine conflicted (nothing applied) and a retry may succeed. */
export class ExecuteAttempt
{
    public static readonly Conflicted = new ExecuteAttempt(undefined)

    private constructor(public readonly Result: CypherExecuteResultDto | undefined)
    {
    }

    public static Done(result: CypherExecuteResultDto): ExecuteAttempt
    {
        return new ExecuteAttempt(result)
    }
}
