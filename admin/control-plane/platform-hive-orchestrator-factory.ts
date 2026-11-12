import { join } from 'node:path'
import { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import type { IHiveOrchestrator } from './hive-orchestrator.js'
import { DockerImageDigest } from './image-digest.js'
import { CryptoImageVerifier, type IImageVerifier } from './image-verifier.js'
import { FileKeyStore } from './key-store.js'
import { KindCli } from './kind.js'
import { KindClusterName } from './kind-cluster-name.js'
import { KindHiveOrchestrator } from './kind-hive-orchestrator.js'
import { NodeExecFile } from './kubectl.js'
import type { HiveRecord } from './platform-records.js'
import { FileSignatureStore } from './signature-store.js'

/**
 * The platform's (dev-box) orchestrator factory: everything HiveOrchestratorFactory drives, with a kubectl-driven hive's images
 * verified against local docker digests and the data root's signature and key stores, plus a Local hive the platform
 * provisions itself, as a kind cluster named after the hive and driven through its kubectl context.
 */
export class PlatformHiveOrchestratorFactory extends HiveOrchestratorFactory
{
    /** The data-root file of image signatures (written by the platform signer, read by every verifier). */
    public static readonly SignaturesFileName = 'signatures.json'
    /** The data-root directory of the key store (trust-root public keys, the platform signing pair). */
    public static readonly KeysDirName = 'keys'

    /** The control plane's image verifier: local docker digests, the data root's signature store and key store. */
    public static VerifierFor(dataRoot: string): CryptoImageVerifier
    {
        return new CryptoImageVerifier(
            new DockerImageDigest(),
            new FileSignatureStore(join(dataRoot, PlatformHiveOrchestratorFactory.SignaturesFileName)),
            new FileKeyStore(join(dataRoot, PlatformHiveOrchestratorFactory.KeysDirName)))
    }

    protected override Verifier(): IImageVerifier
    {
        return PlatformHiveOrchestratorFactory.VerifierFor(this.dataRoot)
    }

    protected override ForProvisionedLocal(hive: HiveRecord): IHiveOrchestrator
    {
        const clusterName = KindClusterName.For(hive.id)
        const inner = this.BuildKubectl(hive, KindClusterName.ContextFor(clusterName))
        return new KindHiveOrchestrator(new KindCli(new NodeExecFile(), new NodeExecFile(KindCli.ImageLoadTimeoutMs)), clusterName, inner)
    }
}
