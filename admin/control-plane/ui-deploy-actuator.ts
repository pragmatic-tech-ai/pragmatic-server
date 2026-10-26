import { UiArtifact } from './ui-artifact.js'
import type { UiArtifactConfig, UiBundleFile } from './ui-artifact.js'
import type { OciRegistryClient } from './oci-registry-client.js'
import type { UiArtifactSigner } from './ui-artifact-signer.js'
import type { IKeyStore } from './key-store.js'
import type { IHiveOrchestrator } from './hive-orchestrator.js'
import type { EnvironmentRecord } from './environment-record.js'
import type { HiveRecord } from './platform-records.js'
import { EnvironmentWorkloadFactory } from './environment-workload.js'
import { EnvServerSeedSource } from './env-server-seed.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'

/** The bundle a deploy publishes: the artifact config plus its files. */
export interface UiDeployBundle
{
    config: UiArtifactConfig
    files: readonly UiBundleFile[]
}

/** Resolves the orchestrator (and so the kubectl) for a hive; satisfied by HiveOrchestratorFactory. */
export interface IHiveOrchestratorSource
{
    For(hive: HiveRecord): IHiveOrchestrator
}

/** Persists an updated environment record. */
export interface IEnvironmentRecordSink
{
    Put(record: EnvironmentRecord): Promise<void>
}

/** The deploy seam EnvironmentService delegates to. */
export interface IUiDeployActuator
{
    DeployAppToEnvironment(record: EnvironmentRecord, hive: HiveRecord, bundle: UiDeployBundle): Promise<EnvironmentRecord>
}

/** Raised when a deploy cannot proceed; fixed message, never carries key or signature material. */
export class UiDeployError extends Error
{
    public static readonly NoTrustRootMessage = 'Hive has no trust root; refusing an unsigned UI deploy'
    private static readonly ErrorName = 'UiDeployError'

    public constructor(message: string)
    {
        super(message)
        this.name = UiDeployError.ErrorName
    }
}

/** Builds, pushes, signs, records and rolls out a UI artifact for one environment. */
export class UiDeployActuator implements IUiDeployActuator
{
    /** Must equal the media type the pod-side unpacker requires of the signature layer. */
    public static readonly SignatureMediaType = 'application/vnd.pragmatic.ui.signature.v1'
    /** Must equal the init container's signature tag suffix (artifactTag + suffix). */
    public static readonly SigTagSuffix = '.sig'
    private static readonly RepoSeparator = '/'
    private static readonly TagSeparator = '-'
    private static readonly EmptyConfigMediaType = 'application/vnd.oci.empty.v1+json'
    private static readonly ManifestMediaType = 'application/vnd.oci.image.manifest.v1+json'
    private static readonly SchemaVersion = 2
    private static readonly EmptyConfigJson = '{}'
    private static readonly Utf8 = 'utf8'

    public constructor(
        private readonly oci: OciRegistryClient,
        private readonly signer: UiArtifactSigner,
        private readonly keys: IKeyStore,
        private readonly orchestrators: IHiveOrchestratorSource,
        private readonly manifests: K8sManifestBuilder,
        private readonly records: IEnvironmentRecordSink)
    {
    }

    public static RepoOf(hive: HiveRecord, appName: string): string
    {
        return (hive.tenantId + UiDeployActuator.RepoSeparator + appName).toLowerCase()
    }

    public static ArtifactTagOf(appName: string, appVersion: string): string
    {
        return appName + UiDeployActuator.TagSeparator + appVersion
    }

    public async DeployAppToEnvironment(record: EnvironmentRecord, hive: HiveRecord, bundle: UiDeployBundle): Promise<EnvironmentRecord>
    {
        const S = UiDeployActuator
        const trustRef = hive.trustRootRef
        if (trustRef === undefined || trustRef.length === 0)
        {
            throw new UiDeployError(UiDeployError.NoTrustRootMessage)
        }
        const { appName, appVersion } = bundle.config
        const repo = S.RepoOf(hive, appName)
        const artifactTag = S.ArtifactTagOf(appName, appVersion)
        const kubectl = this.orchestrators.For(hive).Kubectl

        const packed = UiArtifact.Pack(bundle.config, bundle.files)
        await this.oci.PushBlob(repo, packed.configBlob)
        await this.oci.PushBlob(repo, packed.layerBlob)
        const pushedDigest = await this.oci.PushManifest(repo, artifactTag, packed.manifestBytes)

        const signature = await this.signer.Sign(appName, appVersion, packed.manifestDigest, trustRef)
        await this.PushSignature(repo, artifactTag + S.SigTagSuffix, signature)

        const publicPem = await this.keys.PublicKey(trustRef)
        await EnvServerSeedSource.ApplyUiTrust(kubectl, record.name, trustRef, Buffer.from(publicPem, S.Utf8))

        const updated: EnvironmentRecord = { ...record, appDeployment: { appName, appVersion, repo, artifactTag, manifestDigest: pushedDigest } }
        await this.records.Put(updated)

        await kubectl.Apply(this.manifests.Render(EnvironmentWorkloadFactory.From(updated, hive)))
        await kubectl.RolloutRestart(K8sManifestBuilder.NamespaceOf(record.name), K8sManifestBuilder.ServerDeploymentOf(record.name))
        return updated
    }

    /** Companion artifact: one layer whose blob is the UTF-8 of the base64 signature. */
    private async PushSignature(repo: string, sigTag: string, signatureBase64: string): Promise<void>
    {
        const S = UiDeployActuator
        const encoder = new TextEncoder()
        const sigBlob = encoder.encode(signatureBase64)
        const configBlob = encoder.encode(S.EmptyConfigJson)
        const configDigest = await this.oci.PushBlob(repo, configBlob)
        const sigDigest = await this.oci.PushBlob(repo, sigBlob)
        const manifest = {
            schemaVersion: S.SchemaVersion,
            mediaType: S.ManifestMediaType,
            config: { mediaType: S.EmptyConfigMediaType, digest: configDigest, size: configBlob.byteLength },
            layers: [{ mediaType: S.SignatureMediaType, digest: sigDigest, size: sigBlob.byteLength }],
        }
        await this.oci.PushManifest(repo, sigTag, encoder.encode(JSON.stringify(manifest)))
    }
}
