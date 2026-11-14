import { resolve } from 'node:path'
import type { IImageVerifier } from './image-verifier.js'
import { EffectiveRegistry } from './effective-registry.js'
import { InClusterHiveOrchestrator, type InClusterOrchestration } from './in-cluster-hive-orchestrator.js'
import { ForeignHiveError, UnsupportedBackendError } from './hive-orchestrator.js'
import type { IHiveOrchestrator } from './hive-orchestrator.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { KubectlCli } from './kubectl.js'
import { KubectlHiveOrchestrator } from './kubectl-hive-orchestrator.js'
import { LocalDevCluster } from './local-dev-cluster.js'
import { PinnedImageVerifier } from './pinned-image-verifier.js'
import { HiveBackend, InfraMode } from './platform-records.js'
import type { HiveRecord } from './platform-records.js'

/**
 * Where a hive's backend x mode maps to a concrete orchestrator driver. Inside a tenant console pod (`inCluster` set) the
 * only hive it can drive is its own Local hive, through the Kubernetes API; every other hive is unsupported there.
 * The dev-box drivers are not here, so the in-hive tenant admin never carries them: PlatformHiveOrchestratorFactory, which
 * only the platform composes, verifies images against local docker digests and drives kind-provisioned Local hives. Here an
 * attached hive outside a pod verifies nothing (every image is refused) and a provisioned one is unsupported.
 */
export class HiveOrchestratorFactory
{
    /** An attached Local hive without a configRef runs on the local development kind cluster. */
    private static readonly DefaultLocalContext = LocalDevCluster.Context

    private static readonly DefaultDataRoot = resolve('.pragmatic-data/control-plane')

    public constructor(
        private readonly localContext: string = HiveOrchestratorFactory.DefaultLocalContext,
        protected readonly dataRoot: string = HiveOrchestratorFactory.DefaultDataRoot,
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
            return this.ForProvisionedLocal(hive)
        }
        throw new UnsupportedBackendError(backend, mode)
    }

    /** The driver of a Local hive the platform provisions itself; none here (see PlatformHiveOrchestratorFactory). */
    protected ForProvisionedLocal(hive: HiveRecord): IHiveOrchestrator
    {
        throw new UnsupportedBackendError(hive.cluster.backend, hive.cluster.mode)
    }

    /** The image gate of a kubectl-driven hive; here nothing is approved (the platform's factory checks signed digests). */
    protected Verifier(): IImageVerifier
    {
        return new PinnedImageVerifier([])
    }

    protected BuildKubectl(hive: HiveRecord, context: string): KubectlHiveOrchestrator
    {
        return new KubectlHiveOrchestrator(
            new KubectlCli(context),
            new K8sManifestBuilder(),
            EffectiveRegistry.For(hive),
            this.Verifier(),
            hive.trustRootRef)
    }
}
