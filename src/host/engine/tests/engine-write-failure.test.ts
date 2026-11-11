import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessError, AccessErrorCode, CommitError, CommitErrorCode, ConflictError, ConnectorError, ConnectorPhase, Cypher } from '@pragmatic-tech-ai/graph'
import { WriteFailureKind } from '@pragmatic-tech-ai/todl'
import type { WriteFailure } from '@pragmatic-tech-ai/todl'
import { EngineBridgeError, EngineBridgeErrorCode, ExternalVersionConflict, ExternalWriteError } from '@pragmatic-tech-ai/todl/engine'
import type { IExternalBinding } from '@pragmatic-tech-ai/todl/engine'
import { AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import { EngineWriteFailure } from '../engine-write-failure.js'

/** The S10 failure table, one row per case (plus R7 UnknownExternalBinding and R34 version conflicts). */
class FailureFx
{
    public static readonly Message = 'boom'
    public static readonly ConnectorName = 'src'
    public static readonly Key = 'k1'
    public static readonly WriteConflict = 'write conflict'
    public static readonly WriteFailed = 'write failed'
    public static readonly FieldDenied = 'not authorized for a field'
    public static readonly RecordDenied = 'not authorized for this record'
    public static readonly ReadOnlyBinding = 'binding is read-only'
    public static readonly Binding = { Model: 'ext', Connector: 'src', Binding: { Concept: 'ext.Customer' } } as unknown as IExternalBinding

    public static Bridge(code: EngineBridgeErrorCode): EngineBridgeError
    {
        return new EngineBridgeError(code, FailureFx.Message)
    }

    public static Connector(phase: ConnectorPhase, cause: unknown): ConnectorError
    {
        return new ConnectorError(FailureFx.ConnectorName, phase, cause)
    }

    public static Failures(kind: WriteFailureKind): WriteFailure[]
    {
        return [{ Key: FailureFx.Key, Kind: kind, Reason: FailureFx.Message }, { Key: 'k2', Kind: WriteFailureKind.Error, Reason: FailureFx.Message }]
    }

    public static ExternalWrite(kind: WriteFailureKind): ConnectorError
    {
        return FailureFx.Connector(ConnectorPhase.Commit, new ExternalWriteError(EngineBridgeErrorCode.ExternalWriteFailed, FailureFx.Message, FailureFx.Binding, FailureFx.Failures(kind)))
    }

    public static Expect(error: unknown, status: AppWriteStatus, reason: string): void
    {
        assert.deepEqual(EngineWriteFailure.Map(error), { Status: status, Reason: reason })
    }
}

describe('engine write failure', () =>
{
    test('write failure table', () =>
    {
        FailureFx.Expect(new ConflictError(FailureFx.Message), AppWriteStatus.Conflict, FailureFx.WriteConflict)
        FailureFx.Expect(new AccessError(AccessErrorCode.MemberReadOnly, FailureFx.Message), AppWriteStatus.Denied, FailureFx.FieldDenied)
        FailureFx.Expect(new AccessError(AccessErrorCode.HiddenMember, FailureFx.Message), AppWriteStatus.Denied, FailureFx.FieldDenied)
        FailureFx.Expect(new AccessError(AccessErrorCode.InvisibleNode, FailureFx.Message), AppWriteStatus.Denied, FailureFx.RecordDenied)
        FailureFx.Expect(new CommitError(CommitErrorCode.InvalidValue, FailureFx.Message), AppWriteStatus.Invalid, CommitErrorCode[CommitErrorCode.InvalidValue])
        for (const code of [EngineBridgeErrorCode.NoHomeModel, EngineBridgeErrorCode.AmbiguousExternalBinding, EngineBridgeErrorCode.UnsupportedValue, EngineBridgeErrorCode.UnknownExternalBinding])
        {
            FailureFx.Expect(FailureFx.Bridge(code), AppWriteStatus.Invalid, EngineBridgeErrorCode[code])
        }
        FailureFx.Expect(FailureFx.Connector(ConnectorPhase.Apply, FailureFx.Bridge(EngineBridgeErrorCode.NotWritable)), AppWriteStatus.Invalid, FailureFx.ReadOnlyBinding)
        for (const code of [EngineBridgeErrorCode.ForeignId, EngineBridgeErrorCode.UnsupportedExternalChange, EngineBridgeErrorCode.UnknownExternalBinding])
        {
            FailureFx.Expect(FailureFx.Connector(ConnectorPhase.Apply, FailureFx.Bridge(code)), AppWriteStatus.Invalid, EngineBridgeErrorCode[code])
        }
        FailureFx.Expect(FailureFx.ExternalWrite(WriteFailureKind.Conflict), AppWriteStatus.Conflict, FailureFx.WriteConflict)
        assert.equal(EngineWriteFailure.Map(FailureFx.ExternalWrite(WriteFailureKind.Unsupported))?.Status, AppWriteStatus.Invalid)
        FailureFx.Expect(FailureFx.ExternalWrite(WriteFailureKind.Error), AppWriteStatus.Failed, FailureFx.WriteFailed)
        const compensation = new ExternalWriteError(EngineBridgeErrorCode.CompensationFailed, FailureFx.Message, FailureFx.Binding, [])
        FailureFx.Expect(FailureFx.Connector(ConnectorPhase.Commit, compensation), AppWriteStatus.Failed, FailureFx.WriteFailed)
        FailureFx.Expect(FailureFx.Connector(ConnectorPhase.Commit, new AggregateError([new Error(FailureFx.Message), compensation])), AppWriteStatus.Failed, FailureFx.WriteFailed)
        FailureFx.Expect(FailureFx.Connector(ConnectorPhase.Fetch, FailureFx.Bridge(EngineBridgeErrorCode.ExternalRowInvalid)), AppWriteStatus.Failed, FailureFx.WriteFailed)
        FailureFx.Expect(FailureFx.Connector(ConnectorPhase.Prepare, new Error(FailureFx.Message)), AppWriteStatus.Failed, FailureFx.WriteFailed)
        // R34: read-time version conflicts are the OCC outcome
        const stale = new ExternalVersionConflict(FailureFx.Message, FailureFx.Binding, FailureFx.Failures(WriteFailureKind.Conflict))
        FailureFx.Expect(stale, AppWriteStatus.Conflict, FailureFx.WriteConflict)
        FailureFx.Expect(FailureFx.Connector(ConnectorPhase.Commit, stale), AppWriteStatus.Conflict, FailureFx.WriteConflict)
        FailureFx.Expect(FailureFx.Connector(ConnectorPhase.Commit, new AggregateError([stale, compensation])), AppWriteStatus.Conflict, FailureFx.WriteConflict)
        // the engine Cypher write path wraps each of the above as its cause
        FailureFx.Expect(new Cypher.CypherWriteError(FailureFx.Message, Cypher.CypherWriteErrorCode.Denied, new AccessError(AccessErrorCode.HiddenMember, FailureFx.Message)), AppWriteStatus.Denied, FailureFx.FieldDenied)
        FailureFx.Expect(new Cypher.CypherWriteError(FailureFx.Message, Cypher.CypherWriteErrorCode.Conflict, new ConflictError(FailureFx.Message)), AppWriteStatus.Conflict, FailureFx.WriteConflict)
        FailureFx.Expect(new Cypher.CypherWriteError(FailureFx.Message), AppWriteStatus.Invalid, Cypher.CypherWriteErrorCode[Cypher.CypherWriteErrorCode.Invalid])
        assert.equal(EngineWriteFailure.Map(new Error(FailureFx.Message)), undefined, 'an unknown error is not a write outcome')
    })
})
