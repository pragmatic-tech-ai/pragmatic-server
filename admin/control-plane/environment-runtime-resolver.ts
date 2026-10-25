import type { EnvironmentRecord } from './environment-record.js'
import type { IEnvironmentRuntime } from './environment-runtime.js'
import type { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import type { ITenantDirectory } from './tenant-api/tenant-directory.js'

/**
 * Picks the runtime backend for one environment: hive-bound records run in-cluster, unbound ones on Docker. A
 * hive-bound record's backend is validated EAGERLY here (via the orchestrator factory, a pure lookup that throws
 * UnsupportedBackendError for a backend with no driver) so an unsupported hive fails before EnvironmentService
 * performs any side effect, rather than failing late inside the in-cluster runtime and leaving a Failed record.
 */
export class EnvironmentRuntimeResolver
{
    public constructor(
        private readonly docker: IEnvironmentRuntime,
        private readonly inCluster: IEnvironmentRuntime,
        private readonly directory: ITenantDirectory,
        private readonly orchestrators: HiveOrchestratorFactory)
    {
    }

    public For(record: EnvironmentRecord): IEnvironmentRuntime
    {
        return this.ForHive(record.hiveId)
    }

    /** Resolves the runtime from the hive binding alone, so the caller can select the backend before building the full record. */
    public ForHive(hiveId: string | undefined): IEnvironmentRuntime
    {
        if (hiveId === undefined)
        {
            return this.docker
        }
        const hive = this.directory.GetHive(hiveId)
        if (hive !== undefined)
        {
            // Pure backend lookup, discarded: it throws UnsupportedBackendError for a hive whose backend has no driver.
            this.orchestrators.For(hive)
        }
        // An undefined hive cannot reach here from Create: ResolveHiveTenant already threw UnknownHiveError for an
        // unknown hiveId before any runtime is selected. For a lifecycle verb on a persisted bound record it is the
        // in-cluster runtime that owns this binding, so return it and let it raise its own missing-hive error on use.
        return this.inCluster
    }
}
