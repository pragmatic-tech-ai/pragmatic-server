import { join, resolve } from 'node:path'
import { CryptoImageVerifier } from './image-verifier.js'
import { DockerImageDigest } from './image-digest.js'
import { EffectiveRegistry } from './effective-registry.js'
import { FileKeyStore } from './key-store.js'
import { FileSignatureStore } from './signature-store.js'
import { InClusterHiveOrchestrator, type InClusterOrchestration } from './in-cluster-hive-orchestrator.js'
import { ForeignHiveError, UnsupportedBackendError } from './hive-orchestrator.js'
import type { IHiveOrchestrator } from './hive-orchestrator.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { KindCli } from './kind.js'
import { KindClusterName } from './kind-cluster-name.js'
import { KindHiveOrchestrator } from './kind-hive-orchestrator.js'
import { KubectlCli, NodeExecFile } from './kubectl.js'
import { KubectlHiveOrchestrator } from './kubectl-hive-orchestrator.js'
import { HiveBackend, InfraMode } from './platform-records.js'
import type { HiveRecord } from './platform-records.js'

/**
 * The single place a hive's backend x mode maps to a concrete orchestrator driver. Inside a tenant console pod (`inCluster` set)
 * the only hive it can drive is its own Local hive, through the Kubernetes API; every other hive is unsupported there.
 */
export class HiveOrchestratorFactory
{
    private static readonly DefaultLocalContext = 'docker-desktop'

    private static readonly DefaultDataRoot = resolve('.pragmatic-data/control-plane')
    /** The data-root file of image signatures (written by the platform signer, read by every verifier). */
    public static readonly SignaturesFileName = 'signatures.json'
    /** The data-root directory of the key store (trust-root public keys, the platform signing pair). */
    public static readonly KeysDirName = 'keys'

    public constructor(
        private readonly localContext: string = HiveOrchestratorFactory.DefaultLocalContext,
        private readonly dataRoot: string = HiveOrchestratorFactory.DefaultDataRoot,
        private readonly inCluster?: InClusterOrchestration)
    {
    }

    public For(hive: HiveRecord): IHiveOrchestrator
    {
        const { backend, mode, configRef } = hive.cluster
        if (this.inCluster !== undefined)
        {
            if (hive.id !== this.inCluster.identity.hiveId)
            {
                throw new ForeignHiveError(hive.id, backend, mode)
            }
            if (backend !== HiveBackend.Local)
            {
                throw new UnsupportedBackendError(backend, mode)
            }
            return new InClusterHiveOrchestrator(this.inCluster, EffectiveRegistry.For(hive), hive.trustRootRef)
        }
        if (backend === HiveBackend.Local && mode === InfraMode.Attach)
        {
            return this.BuildKubectl(hive, configRef ?? this.localContext)
        }
        if (backend === HiveBackend.Local && mode === InfraMode.Provision)
        {
            const clusterName = KindClusterName.For(hive.id)
            const inner = this.BuildKubectl(hive, KindClusterName.ContextFor(clusterName))
            return new KindHiveOrchestrator(new KindCli(new NodeExecFile(), new NodeExecFile(KindCli.ImageLoadTimeoutMs)), clusterName, inner)
        }
        throw new UnsupportedBackendError(backend, mode)
    }

    /** The control plane's image verifier: local docker digests, the data root's signature store and key store. */
    public static VerifierFor(dataRoot: string): CryptoImageVerifier
    {
        return new CryptoImageVerifier(
            new DockerImageDigest(),
            new FileSignatureStore(join(dataRoot, HiveOrchestratorFactory.SignaturesFileName)),
            new FileKeyStore(join(dataRoot, HiveOrchestratorFactory.KeysDirName)))
    }

    private BuildKubectl(hive: HiveRecord, context: string): KubectlHiveOrchestrator
    {
        return new KubectlHiveOrchestrator(
            new KubectlCli(context),
            new K8sManifestBuilder(),
            EffectiveRegistry.For(hive),
            HiveOrchestratorFactory.VerifierFor(this.dataRoot),
            hive.trustRootRef)
    }
}
