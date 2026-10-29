import { join, resolve } from 'node:path'
import { CryptoImageVerifier } from './image-verifier.js'
import { DockerImageDigest } from './image-digest.js'
import { EffectiveRegistry } from './effective-registry.js'
import { FileKeyStore } from './key-store.js'
import { FileSignatureStore } from './signature-store.js'
import { UnsupportedBackendError } from './hive-orchestrator.js'
import type { IHiveOrchestrator } from './hive-orchestrator.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { KindCli } from './kind.js'
import { KindClusterName } from './kind-cluster-name.js'
import { KindHiveOrchestrator } from './kind-hive-orchestrator.js'
import { KubectlCli, NodeExecFile } from './kubectl.js'
import { KubectlHiveOrchestrator } from './kubectl-hive-orchestrator.js'
import { HiveBackend, InfraMode } from './platform-records.js'
import type { HiveRecord } from './platform-records.js'

/** The single place a hive's backend x mode maps to a concrete orchestrator driver. */
export class HiveOrchestratorFactory
{
    private static readonly DefaultLocalContext = 'docker-desktop'

    private static readonly DefaultDataRoot = resolve('.pragmatic-data/control-plane')
    private static readonly SignaturesFileName = 'signatures.json'
    private static readonly KeysDirName = 'keys'

    public constructor(
        private readonly localContext: string = HiveOrchestratorFactory.DefaultLocalContext,
        private readonly dataRoot: string = HiveOrchestratorFactory.DefaultDataRoot)
    {
    }

    public For(hive: HiveRecord): IHiveOrchestrator
    {
        const { backend, mode, configRef } = hive.cluster
        if (backend === HiveBackend.Local && mode === InfraMode.Attach)
        {
            return this.BuildKubectl(hive, configRef ?? this.localContext)
        }
        if (backend === HiveBackend.Local && mode === InfraMode.Provision)
        {
            const clusterName = KindClusterName.For(hive.id)
            const inner = this.BuildKubectl(hive, KindClusterName.ContextFor(clusterName))
            return new KindHiveOrchestrator(new KindCli(new NodeExecFile()), clusterName, inner)
        }
        throw new UnsupportedBackendError(backend, mode)
    }

    private BuildKubectl(hive: HiveRecord, context: string): KubectlHiveOrchestrator
    {
        const verifier = new CryptoImageVerifier(
            new DockerImageDigest(),
            new FileSignatureStore(join(this.dataRoot, HiveOrchestratorFactory.SignaturesFileName)),
            new FileKeyStore(join(this.dataRoot, HiveOrchestratorFactory.KeysDirName)))
        return new KubectlHiveOrchestrator(
            new KubectlCli(context),
            new K8sManifestBuilder(),
            EffectiveRegistry.For(hive),
            verifier,
            hive.trustRootRef)
    }
}
