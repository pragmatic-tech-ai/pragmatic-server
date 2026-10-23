import type { EnvironmentPlacement } from './environment-placement.js'
import type { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import type { EnvironmentRecord } from './environment-record.js'
import type { HiveRecord } from './platform-records.js'

/** One environment's live workload health on its hive: no secrets, no internals. */
export type HiveHealthDto = {
    environmentName: string
    ready: boolean
    runningImage: string | undefined
    detail: string
}

/** The environment-listing seam the health producer reads: the operator service and the tenant read API both satisfy it. */
export interface IEnvironmentHealthSource
{
    List(): readonly EnvironmentRecord[]
}

/**
 * Produces the per-environment health DTO list for one hive: resolves the hive's orchestrator, then probes every
 * environment bound to the hive. Shared by the operator `GET /api/hives/:id/health` route and the tenant
 * `GET /tenant-api/hives/:id/health` route so both return the identical health shape. The caller is responsible
 * for resolving the hive (and, on the tenant plane, the ownership check) before handing the record here.
 */
export class HiveHealthProducer
{
    public constructor(
        private readonly environments: IEnvironmentHealthSource,
        private readonly orchestrators: HiveOrchestratorFactory,
        private readonly placement: EnvironmentPlacement)
    {
    }

    public async Produce(hive: HiveRecord): Promise<HiveHealthDto[]>
    {
        const orchestrator = this.orchestrators.For(hive)
        const dtos: HiveHealthDto[] = []
        for (const env of this.environments.List().filter(e => e.hiveId === hive.id))
        {
            const health = await orchestrator.Health(this.placement.WorkloadFor(env))
            dtos.push({ environmentName: env.name, ready: health.ready, runningImage: health.runningImage, detail: health.detail })
        }
        return dtos
    }
}
