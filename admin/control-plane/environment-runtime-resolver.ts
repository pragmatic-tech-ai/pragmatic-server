import type { EnvironmentRecord } from './environment-record.js'
import type { IEnvironmentRuntime } from './environment-runtime.js'

/** Picks the runtime backend for one environment: hive-bound records run in-cluster, unbound ones on Docker. Backend support is validated by the orchestrator factory, not here. */
export class EnvironmentRuntimeResolver
{
    public constructor(
        private readonly docker: IEnvironmentRuntime,
        private readonly inCluster: IEnvironmentRuntime)
    {
    }

    public For(record: EnvironmentRecord): IEnvironmentRuntime
    {
        return record.hiveId === undefined ? this.docker : this.inCluster
    }
}
