import { AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { CypherExecuteResultDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { Cypher } from '@pragmatic-tech-ai/todl'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { DevModelWriter, DevModelWriteFailedError, DevModelSchemaColocatedError } from '../model/dev-model-writer.js'
import type { DevModelIdentity, DevModelPrepared } from '../model/dev-model-writer.js'
import { AuthorizingCypherWriter, WriteAuthorizationError } from './authorizing-cypher-writer.js'
import { CypherExecuteResultMapper } from './cypher-execute-result-mapper.js'
import type { IDevWriteSecurity } from './dev-write-security.js'
import { AsyncMutex } from './async-mutex.js'

/** A validated cypher/execute request, free of wire concerns. */
export interface DevCypherRequest
{
    cypher: string
    parameters: ReadonlyMap<string, Cypher.ParameterValue>
    expectedRevision?: number
    timeoutMs: number
    maxVarLength: number
}

export interface DevCypherTarget
{
    member: { Storage: IStorage }
    identity: DevModelIdentity
}

/**
 * Plan -> authorize -> commit -> persist for one Cypher write, serialized per tenant. Nothing persists on any failure.
 * The mutex is per-process: across cluster workers only the source-hash CAS protects, leaving a small CAS-to-Persist
 * TOCTOU window (acceptable for a dev endpoint; a cross-process lock is a deferred Feature).
 */
export class DevCypherExecutor
{
    private static readonly SourcesChangedReason = 'model sources changed during the write'
    private static readonly InvalidReason = 'the write is not valid against the model'
    private static readonly FailedReason = 'the model could not be persisted; no changes were kept'
    private static readonly RevisionReason = 'graph revision has advanced'
    private readonly mutex = new AsyncMutex()

    constructor(private readonly writer: DevModelWriter, private readonly revision: () => number)
    {
    }

    public Execute(request: DevCypherRequest, target: DevCypherTarget, security: IDevWriteSecurity): Promise<CypherExecuteResultDto>
    {
        return this.mutex.Run(() => this.Run(request, target, security))
    }

    private async Run(request: DevCypherRequest, target: DevCypherTarget, security: IDevWriteSecurity): Promise<CypherExecuteResultDto>
    {
        if (request.expectedRevision !== undefined && request.expectedRevision !== this.revision())
        {
            return CypherExecuteResultMapper.ToWire(AppWriteStatus.Conflict, this.revision(), undefined, DevCypherExecutor.RevisionReason)
        }
        let prepared: DevModelPrepared
        try
        {
            prepared = await this.writer.Prepare(target.member, target.identity, security.Mask)
        }
        catch (error)
        {
            if (error instanceof DevModelSchemaColocatedError)
            {
                return CypherExecuteResultMapper.ToWire(AppWriteStatus.Invalid, this.revision(), undefined, DevModelSchemaColocatedError.Message)
            }
            throw error
        }
        const gate = await security.GateFor(prepared.draft.model, prepared.graph)
        let result: Cypher.CypherResult
        try
        {
            const engine = new Cypher.CypherEngine(prepared.graph, { MaxVarLength: request.maxVarLength }, new AuthorizingCypherWriter(prepared.writer, gate, prepared.graph))
            result = engine.Execute(request.cypher, request.parameters, { Cancel: Cypher.Deadline.After(request.timeoutMs) })
        }
        catch (error)
        {
            if (error instanceof WriteAuthorizationError)
            {
                return CypherExecuteResultMapper.ToWire(AppWriteStatus.Denied, this.revision(), undefined, error.message)
            }
            if (error instanceof Cypher.CypherWriteError)
            {
                return CypherExecuteResultMapper.ToWire(AppWriteStatus.Invalid, this.revision(), undefined, DevCypherExecutor.InvalidReason)
            }
            throw error
        }
        const dto = Cypher.CypherEngine.ToDto(result)
        if (!CypherExecuteResultMapper.Changed(dto.Stats))
        {
            return CypherExecuteResultMapper.ToWire(AppWriteStatus.Applied, this.revision(), dto)
        }
        if (await this.writer.CurrentSourceHash(target.member) !== this.writer.SourceHash(prepared.sources))
        {
            return CypherExecuteResultMapper.ToWire(AppWriteStatus.Conflict, this.revision(), undefined, DevCypherExecutor.SourcesChangedReason)
        }
        let revision: number
        try
        {
            revision = await this.writer.Persist(prepared.draft, target.member)
        }
        catch (error)
        {
            if (error instanceof DevModelWriteFailedError)
            {
                return CypherExecuteResultMapper.ToWire(AppWriteStatus.Failed, this.revision(), undefined, DevCypherExecutor.FailedReason)
            }
            throw error
        }
        return CypherExecuteResultMapper.ToWire(AppWriteStatus.Applied, revision, dto)
    }
}
