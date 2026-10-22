import { UnsupportedBackendError } from './hive-orchestrator.js'
import type { IHiveOrchestrator } from './hive-orchestrator.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { KubectlCli } from './kubectl.js'
import { KubectlHiveOrchestrator } from './kubectl-hive-orchestrator.js'
import { HiveBackend, InfraMode } from './platform-records.js'
import type { HiveRecord } from './platform-records.js'

/** The single place a hive's backend x mode maps to a concrete orchestrator driver. */
export class HiveOrchestratorFactory
{
    private static readonly DefaultLocalContext = 'docker-desktop'

    public constructor(private readonly localContext: string = HiveOrchestratorFactory.DefaultLocalContext)
    {
    }

    public For(hive: HiveRecord): IHiveOrchestrator
    {
        const { backend, mode, configRef } = hive.cluster
        if (backend === HiveBackend.Local && mode === InfraMode.Attach)
        {
            return new KubectlHiveOrchestrator(new KubectlCli(configRef ?? this.localContext), new K8sManifestBuilder())
        }
        throw new UnsupportedBackendError(backend, mode)
    }
}
