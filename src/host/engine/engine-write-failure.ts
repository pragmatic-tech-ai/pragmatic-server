import { AccessError, AccessErrorCode, CommitError, CommitErrorCode, ConflictError, ConnectorError, ConnectorPhase, Cypher } from '@pragmatic-tech-ai/graph'
import { WriteFailureKind } from '@pragmatic-tech-ai/todl'
import { EngineBridgeError, EngineBridgeErrorCode, ExternalWriteError } from '@pragmatic-tech-ai/todl/engine'
import { AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'

/** What a failed engine write means for the caller: the wire status and its reason. */
export interface IWriteFailureOutcome
{
    readonly Status: AppWriteStatus
    readonly Reason: string
}

/**
 * The one failure table of every engine write, dev and runtime (rulings S1, S10, R7, R9, R34). `Map` returns undefined
 * for an error that is not a write outcome (the caller rethrows it: InternalError).
 *
 * - A ConflictError (TODL ExternalVersionConflict included), `CypherWriteErrorCode.Conflict`, or a ConnectorError whose
 *   `IsConflict` holds (a stale read-time version, R34) -> `conflict` "write conflict".
 * - AccessError MemberReadOnly / HiddenMember -> `denied` "not authorized for a field"; any other -> `denied` "not
 *   authorized for this record".
 * - CommitError -> `invalid` with the CommitErrorCode name.
 * - An EngineBridgeError thrown by placement (NoHomeModel, AmbiguousExternalBinding, UnsupportedValue) or naming an
 *   unknown binding (UnknownExternalBinding, R7) -> `invalid` with the code name; the same codes, ForeignId and
 *   UnsupportedExternalChange as a ConnectorError Apply cause likewise; NotWritable -> `invalid` "binding is read-only".
 * - A ConnectorError whose cause is an ExternalWriteError ExternalWriteFailed -> by its first failure's kind: conflict
 *   -> `conflict`, unsupported -> `invalid`, error -> `failed`.
 * - CompensationFailed, a revert that also failed (AggregateError cause), a Fetch-phase failure, a Prepare timeout,
 *   an adapter error, any other ConnectorError or bridge code -> `failed` "write failed".
 * - The engine Cypher write path wraps each of these as a CypherWriteError cause; one without a cause maps by its
 *   WriteCode (Denied -> record denied, ConnectorFailed -> failed, else `invalid` with the code name).
 */
export class EngineWriteFailure
{
    public static readonly WriteConflict = 'write conflict'
    public static readonly WriteFailed = 'write failed'
    public static readonly FieldDenied = 'not authorized for a field'
    public static readonly RecordDenied = 'not authorized for this record'
    public static readonly ReadOnlyBinding = 'binding is read-only'
    public static readonly UnsupportedBySource = 'the source cannot apply the write'

    private static readonly Conflict: IWriteFailureOutcome = { Status: AppWriteStatus.Conflict, Reason: EngineWriteFailure.WriteConflict }
    private static readonly Failed: IWriteFailureOutcome = { Status: AppWriteStatus.Failed, Reason: EngineWriteFailure.WriteFailed }

    public static Map(error: unknown): IWriteFailureOutcome | undefined
    {
        if (error instanceof Cypher.CypherWriteError) return EngineWriteFailure.CypherWrite(error)
        if (error instanceof ConflictError) return EngineWriteFailure.Conflict
        if (error instanceof AccessError) return EngineWriteFailure.Access(error)
        if (error instanceof CommitError) return EngineWriteFailure.Invalid(CommitErrorCode[error.Code])
        if (error instanceof ConnectorError) return EngineWriteFailure.Connector(error)
        if (error instanceof EngineBridgeError) return EngineWriteFailure.Bridge(error)
        return undefined
    }

    private static CypherWrite(error: Cypher.CypherWriteError): IWriteFailureOutcome
    {
        const cause = EngineWriteFailure.Map(error.cause)
        if (cause !== undefined) return cause
        switch (error.WriteCode)
        {
            case Cypher.CypherWriteErrorCode.Conflict:
                return EngineWriteFailure.Conflict
            case Cypher.CypherWriteErrorCode.Denied:
                return { Status: AppWriteStatus.Denied, Reason: EngineWriteFailure.RecordDenied }
            case Cypher.CypherWriteErrorCode.ConnectorFailed:
                return EngineWriteFailure.Failed
            default:
                return EngineWriteFailure.Invalid(Cypher.CypherWriteErrorCode[error.WriteCode])
        }
    }

    private static Access(error: AccessError): IWriteFailureOutcome
    {
        const field = error.Code === AccessErrorCode.MemberReadOnly || error.Code === AccessErrorCode.HiddenMember
        return { Status: AppWriteStatus.Denied, Reason: field ? EngineWriteFailure.FieldDenied : EngineWriteFailure.RecordDenied }
    }

    private static Connector(error: ConnectorError): IWriteFailureOutcome
    {
        if (error.IsConflict) return EngineWriteFailure.Conflict
        if (error.Phase === ConnectorPhase.Fetch) return EngineWriteFailure.Failed
        const cause = error.cause
        if (cause instanceof ExternalWriteError) return EngineWriteFailure.ExternalWrite(cause)
        if (cause instanceof EngineBridgeError) return EngineWriteFailure.Bridge(cause)
        return EngineWriteFailure.Failed
    }

    private static ExternalWrite(error: ExternalWriteError): IWriteFailureOutcome
    {
        if (error.Code !== EngineBridgeErrorCode.ExternalWriteFailed) return EngineWriteFailure.Failed
        switch (error.Failures[0]?.Kind)
        {
            case WriteFailureKind.Conflict:
                return EngineWriteFailure.Conflict
            case WriteFailureKind.Unsupported:
                return { Status: AppWriteStatus.Invalid, Reason: EngineWriteFailure.UnsupportedBySource }
            default:
                return EngineWriteFailure.Failed
        }
    }

    private static Bridge(error: EngineBridgeError): IWriteFailureOutcome
    {
        if (error instanceof ExternalWriteError) return EngineWriteFailure.ExternalWrite(error)
        switch (error.Code)
        {
            case EngineBridgeErrorCode.NotWritable:
                return { Status: AppWriteStatus.Invalid, Reason: EngineWriteFailure.ReadOnlyBinding }
            case EngineBridgeErrorCode.NoHomeModel:
            case EngineBridgeErrorCode.AmbiguousExternalBinding:
            case EngineBridgeErrorCode.UnsupportedValue:
            case EngineBridgeErrorCode.UnknownExternalBinding:
            case EngineBridgeErrorCode.ForeignId:
            case EngineBridgeErrorCode.UnsupportedExternalChange:
                return EngineWriteFailure.Invalid(EngineBridgeErrorCode[error.Code])
            default:
                return EngineWriteFailure.Failed
        }
    }

    private static Invalid(reason: string): IWriteFailureOutcome
    {
        return { Status: AppWriteStatus.Invalid, Reason: reason }
    }
}
