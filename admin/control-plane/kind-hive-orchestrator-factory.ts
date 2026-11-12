import { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import type { IHiveOrchestrator } from './hive-orchestrator.js'
import { KindCli } from './kind.js'
import { KindClusterName } from './kind-cluster-name.js'
import { KindHiveOrchestrator } from './kind-hive-orchestrator.js'
import { NodeExecFile } from './kubectl.js'
import type { HiveRecord } from './platform-records.js'

/**
 * The platform's (dev-box) orchestrator factory: everything HiveOrchestratorFactory drives, plus a Local hive the platform
 * provisions itself, as a kind cluster named after the hive and driven through its kubectl context.
 */
export class KindHiveOrchestratorFactory extends HiveOrchestratorFactory
{
    protected override ForProvisionedLocal(hive: HiveRecord): IHiveOrchestrator
    {
        const clusterName = KindClusterName.For(hive.id)
        const inner = this.BuildKubectl(hive, KindClusterName.ContextFor(clusterName))
        return new KindHiveOrchestrator(new KindCli(new NodeExecFile(), new NodeExecFile(KindCli.ImageLoadTimeoutMs)), clusterName, inner)
    }
}
