import type { IKubectl } from './kubectl.js'
import type { EnvironmentWorkload } from './environment-workload.js'
import type { HiveBackend, InfraMode } from './platform-records.js'

export type WorkloadHealth = { ready: boolean; runningImage: string | undefined; detail: string }

export interface IHiveOrchestrator
{
    readonly Kubectl: IKubectl
    Apply(w: EnvironmentWorkload): Promise<void>
    WaitHealthy(w: EnvironmentWorkload): Promise<void>
    Health(w: EnvironmentWorkload): Promise<WorkloadHealth>
    Roll(w: EnvironmentWorkload, image: string): Promise<void>
    Scale(workload: EnvironmentWorkload, replicas: number): Promise<void>
    /** Scales the workload's database StatefulSet. Scaling UP resolves only once a replica is ready; scaling to zero does not wait. */
    ScaleDatabase(workload: EnvironmentWorkload, replicas: number): Promise<void>
    Teardown(w: EnvironmentWorkload): Promise<void>
    /** Readies the cluster to run the hive agent with this image (a kind cluster is created and the image loaded); a no-op where there is nothing to prepare. */
    PrepareAgent(image: string): Promise<void>
}

/** Raised when no orchestrator driver exists for a backend + infra mode combination. */
export class UnsupportedBackendError extends Error
{
    private static readonly Template = 'Unsupported hive backend: '
    private static readonly ModeJoin = ' with mode '
    private static readonly ErrorName = 'UnsupportedBackendError'

    public constructor(public readonly backend: HiveBackend, public readonly mode: InfraMode)
    {
        super(UnsupportedBackendError.Template + backend + UnsupportedBackendError.ModeJoin + mode)
        this.name = UnsupportedBackendError.ErrorName
    }
}

/** Inside a tenant console pod: the hive is not the console's own, so the console has no driver for it. */
export class ForeignHiveError extends UnsupportedBackendError
{
    private static readonly MessagePrefix = 'The tenant console manages only its own hive: '
    private static readonly ForeignErrorName = 'ForeignHiveError'

    public constructor(public readonly HiveId: string, backend: HiveBackend, mode: InfraMode)
    {
        super(backend, mode)
        this.message = ForeignHiveError.MessagePrefix + HiveId
        this.name = ForeignHiveError.ForeignErrorName
    }
}
