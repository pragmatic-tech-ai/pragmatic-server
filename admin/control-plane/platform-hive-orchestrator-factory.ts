import { join } from 'node:path'
import { HiveOrchestratorFactory, type IHiveOrchestrator, KindClusterName, type HiveRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { type IImageDigest, CryptoImageVerifier, type IImageVerifier, FileKeyStore, type ISignatureStore } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { DockerImageDigest } from './image-digest.js'
import { KindCli } from './kind.js'
import { KindHiveOrchestrator } from './kind-hive-orchestrator.js'
import { NodeExecFile } from '@pragmatic-tech-ai/pragmatic-kube'
import { FileSignatureStore } from './signature-store.js'

/**
 * The platform's (dev-box) orchestrator factory: everything HiveOrchestratorFactory drives, with a kubectl-driven hive's images
 * verified against the given image digests (local docker by default) and the data root's signature and key stores, plus a Local hive the platform
 * provisions itself, as a kind cluster named after the hive and driven through its kubectl context.
 */
export class PlatformHiveOrchestratorFactory extends HiveOrchestratorFactory
{
    /** The data-root file of image signatures (written by the platform signer, read by every verifier). */
    public static readonly SignaturesFileName = 'signatures.json'
    /** The data-root directory of the key store (trust-root public keys, the platform signing pair). */
    public static readonly KeysDirName = 'keys'

    /** The control plane's image verifier: the given digests, signature store (the data root's file when none is given:
     *  development tools) and the data root's key store. */
    public static VerifierFor(dataRoot: string, digests: IImageDigest = new DockerImageDigest(), signatures?: ISignatureStore): CryptoImageVerifier
    {
        return new CryptoImageVerifier(
            digests,
            signatures ?? new FileSignatureStore(join(dataRoot, PlatformHiveOrchestratorFactory.SignaturesFileName)),
            new FileKeyStore(join(dataRoot, PlatformHiveOrchestratorFactory.KeysDirName)))
    }

    /** `signatures`: the platform's signature store (the console's Postgres store); omitted, the data root's file. */
    public constructor(localContext?: string, dataRoot?: string, private readonly digests: IImageDigest = new DockerImageDigest(), private readonly signatures?: ISignatureStore)
    {
        super(localContext, dataRoot)
    }

    protected override Verifier(): IImageVerifier
    {
        return PlatformHiveOrchestratorFactory.VerifierFor(this.dataRoot, this.digests, this.signatures)
    }

    protected override ForProvisionedLocal(hive: HiveRecord): IHiveOrchestrator
    {
        const clusterName = KindClusterName.For(hive.id)
        const inner = this.BuildKubectl(hive, KindClusterName.ContextFor(clusterName))
        return new KindHiveOrchestrator(new KindCli(new NodeExecFile(), new NodeExecFile(KindCli.ImageLoadTimeoutMs)), clusterName, inner)
    }
}
