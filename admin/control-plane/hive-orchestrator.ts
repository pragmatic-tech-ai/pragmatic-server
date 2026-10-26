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
    Teardown(w: EnvironmentWorkload): Promise<void>
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
