import { UnsupportedBackendError, type IHiveOrchestrator, HiveBackend, InfraMode, type HiveRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { NoInfraTargetBackendError } from './no-infra-target.js'
import { PlatformHiveOrchestratorFactory } from './platform-hive-orchestrator-factory.js'

/** A hosted hive was registered without the kubeconfig context of its cluster, so there is nothing to drive. Maps to 400. */
export class HostedClusterRefMissingError extends UnsupportedBackendError
{
    private static readonly BackendErrorName = 'HostedClusterRefMissingError'
    private static readonly Message = "a hosted hive must name its cluster's kubeconfig context (configRef)"

    public constructor(hive: HiveRecord)
    {
        super(hive.cluster.backend, hive.cluster.mode)
        this.message = HostedClusterRefMissingError.Message
        this.name = HostedClusterRefMissingError.BackendErrorName
    }
}

/**
 * `PRAGMATIC_ADMIN_INFRA_TARGET=hosted`: drives only clusters registered on our machines, each by the kubeconfig context its
 * hive names (configRef), over the mesh. It never falls back to the local development cluster and never provisions (kind
 * is never reached); images are verified by registry digest through the digests the platform factory is given.
 */
export class HostedHiveOrchestratorFactory extends PlatformHiveOrchestratorFactory
{
    public override For(hive: HiveRecord): IHiveOrchestrator
    {
        const { backend, mode, configRef } = hive.cluster
        if (backend === HiveBackend.Local && mode === InfraMode.Attach)
        {
            if (configRef === undefined || configRef.length === 0)
            {
                throw new HostedClusterRefMissingError(hive)
            }
            return this.BuildKubectl(hive, configRef)
        }
        if (backend === HiveBackend.Local && mode === InfraMode.Provision)
        {
            throw new NoInfraTargetBackendError(hive)
        }
        throw new UnsupportedBackendError(backend, mode)
    }
}
