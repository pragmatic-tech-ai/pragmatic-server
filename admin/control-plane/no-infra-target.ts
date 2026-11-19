import { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import { UnsupportedBackendError } from './hive-orchestrator.js'
import type { IHiveOrchestrator } from './hive-orchestrator.js'
import type { IdpRecord } from './idp-record.js'
import type { IImageDigest } from './image-digest.js'
import type { IdpWorkloadRequest, IdpWorkloadResult, IIdpWorkloadDriver } from './idp-workload-driver.js'
import { NoHostEnvironmentRuntime } from './no-host-environment-runtime.js'
import type { HiveRecord } from './platform-records.js'

/** The one sentence every refusal in `PRAGMATIC_ADMIN_INFRA_TARGET=none` mode says (D28 interim). */
export class NoInfraTarget
{
    public static readonly Message = 'no Docker/cluster target configured'
}

/** An operation needed a Docker engine or a cluster, and this admin has no target for either. */
export class NoInfraTargetError extends Error
{
    private static readonly ErrorName = 'NoInfraTargetError'

    public constructor()
    {
        super(NoInfraTarget.Message)
        this.name = NoInfraTargetError.ErrorName
    }
}

/**
 * The orchestrator-side refusal. It is an UnsupportedBackendError, so the paths that already treat an undrivable hive
 * as a no-op (rollout push, cluster destroy, environment endpoints) keep doing so; its message is the plain sentence.
 */
export class NoInfraTargetBackendError extends UnsupportedBackendError
{
    private static readonly BackendErrorName = 'NoInfraTargetBackendError'

    public constructor(hive: HiveRecord)
    {
        super(hive.cluster.backend, hive.cluster.mode)
        this.message = NoInfraTarget.Message
        this.name = NoInfraTargetBackendError.BackendErrorName
    }
}

/** Drives no hive: every hive is refused before kubectl or kind is ever spawned. */
export class NoTargetHiveOrchestratorFactory extends HiveOrchestratorFactory
{
    public override For(hive: HiveRecord): IHiveOrchestrator
    {
        throw new NoInfraTargetBackendError(hive)
    }
}

/** Launches no per-tenant IdP container: there is no Docker engine to run it on. */
export class NoTargetIdpDriver implements IIdpWorkloadDriver
{
    public EnsureRunning(_request: IdpWorkloadRequest): Promise<IdpWorkloadResult>
    {
        return Promise.reject(new NoInfraTargetError())
    }

    public async Discard(_record: IdpRecord): Promise<void>
    {
    }
}

/** Reads no image digest: there is no local docker to ask (signers then record signed:false, verifiers refuse). */
export class NoTargetImageDigest implements IImageDigest
{
    public Of(_imageRef: string): Promise<string>
    {
        return Promise.reject(new NoInfraTargetError())
    }
}

/** Runs no host (Docker) environment: nothing is running, stop passes, every bring-up says there is no target. */
export class NoTargetEnvironmentRuntime extends NoHostEnvironmentRuntime
{
    protected override Refusal(_name?: string): Error
    {
        return new NoInfraTargetError()
    }
}
