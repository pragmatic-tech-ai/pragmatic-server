/**
 * GATED real-cluster smoke for the SP-HIVE-4 rollout PUSH path. NOT part of `tsx --test`.
 *
 * Requires Docker Desktop's built-in Kubernetes (context `docker-desktop`), docker, and the
 * `pragmatic-server:dev` image in the local docker image store. Run with:
 *
 *   npx tsx admin/control-plane/rollout-push-smoke.ts
 *
 * Tags the dev image as `:v1` and `:v2` (the SAME bits under two refs; what differs is the ref the
 * Deployment runs), signs both refs with a throwaway dev Ed25519 key into the stores of the
 * HiveOrchestratorFactory dataRoot, publishes + gates both through a PlatformDeploymentRegistry, brings
 * an environment up on v1, then SelectTarget(v2) pushes (the SP-HIVE-3 gate verifies inside Roll) and
 * SelectTarget(v1) rolls back. The running image is read from the live Deployment after each step.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClientRegistry } from './client-registry.js'
import { EnvironmentPlacement } from './environment-placement.js'
import { EnvironmentRegistry } from './environment-registry.js'
import { EnvStatus, EnvType, Template } from './environment-record.js'
import type { EnvironmentRecord, IContainerProbe } from './environment-record.js'
import type { EnvironmentWorkload } from './environment-workload.js'
import { GatingRegistry } from './gating-record.js'
import { HiveObservationRegistry } from './hive-observation-record.js'
import { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import type { IHiveOrchestrator } from './hive-orchestrator.js'
import { HiveRegistry } from './hive-registry.js'
import { DockerImageDigest } from './image-digest.js'
import { ImageSigner } from './image-signer.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { KindImageLoader } from './kind-image-loader.js'
import { FileKeyStore } from './key-store.js'
import { KubectlCli, KubectlError, NodeExecFile } from './kubectl.js'
import { ManifestRegistry } from './manifest-record.js'
import { PlatformDeploymentRegistry } from './platform-deployment-registry.js'
import { PlatformDirectory } from './platform-directory.js'
import { HiveBackend, InfraMode } from './platform-records.js'
import { RolloutRegistrationRegistry } from './rollout-registration-record.js'
import { RolloutReportRegistry } from './rollout-report-record.js'
import { SelectionRegistry } from './selection-record.js'
import { FileSignatureStore } from './signature-store.js'
import { TenantRegistry } from './tenant-registry.js'

/** The smoke never reconciles against docker, so no container is ever reported running. */
class NoContainerProbe implements IContainerProbe
{
    public async Running(_containerName: string): Promise<boolean>
    {
        return false
    }
}

export class RolloutPushSmoke
{
    private static readonly Context = 'docker-desktop'
    private static readonly EnvPrefix = 'push-smoke-'
    private static readonly SuffixBytes = 3
    private static readonly Hex = 'hex'
    private static readonly ClientId = 'push-client'
    private static readonly TenantId = 'push-tenant'
    private static readonly HiveId = 'push-hive'
    private static readonly BaseImage = 'pragmatic-server:dev'
    private static readonly ImageV1 = 'pragmatic-server:v1'
    private static readonly ImageV2 = 'pragmatic-server:v2'
    private static readonly VersionV1 = 'v1'
    private static readonly VersionV2 = 'v2'
    private static readonly Docker = 'docker'
    private static readonly TagVerb = 'tag'
    private static readonly ImageVerb = 'rmi'
    private static readonly Kubectl = 'kubectl'
    private static readonly ContextFlag = '--context'
    private static readonly GetVerb = 'get'
    private static readonly NamespaceKind = 'namespace'
    private static readonly NotFoundWord = 'NotFound'
    private static readonly KeysDirName = 'keys'
    private static readonly SignaturesFileName = 'signatures.json'
    private static readonly ManifestsFileName = 'manifests.json'
    private static readonly GatingFileName = 'gating.json'
    private static readonly SelectionsFileName = 'selections.json'
    private static readonly ReportsFileName = 'reports.json'
    private static readonly ObservationsFileName = 'hive-observations.json'
    private static readonly RegistrationsFileName = 'registrations.json'
    private static readonly ClientsFileName = 'clients.json'
    private static readonly TenantsFileName = 'tenants.json'
    private static readonly HivesFileName = 'hives.json'
    private static readonly EnvironmentsFileName = 'environments.json'
    private static readonly DataRootDirName = 'data'
    private static readonly TempDirPrefix = 'push-smoke-'
    private static readonly SigningKeyRef = 'dev-signing'
    private static readonly Ed25519 = 'ed25519'
    private static readonly Pem = 'pem'
    private static readonly Spki = 'spki'
    private static readonly Pkcs8 = 'pkcs8'
    private static readonly Utf8 = 'utf8'
    private static readonly EpochIso = '1970-01-01T00:00:00.000Z'
    private static readonly EmptyString = ''
    private static readonly DisplayName = 'push smoke'
    private static readonly BootBaseDirKey = 'PRAGMATIC_BASE_DIR'
    private static readonly BootBaseDir = '/tmp/pragmatic-data'
    private static readonly BootTenantKey = 'PRAGMATIC_ENVIRONMENT_ID'
    private static readonly BootMasterKeyEnvKey = 'PRAGMATIC_MASTER_KEY_B64_ENV'
    private static readonly BootMasterKeyVar = 'SMOKE_MASTER_KEY_B64'
    private static readonly MasterKeyBytes = 32
    private static readonly Base64 = 'base64'
    private static readonly PassTag = 'PASS '
    private static readonly FailTag = 'FAIL '
    private static readonly DetailSep = ' -- '
    private static readonly InfoTag = 'INFO '
    private static readonly TeardownWarning = 'WARN best-effort teardown failed for '
    private static readonly OverallPass = 'OVERALL PASS'
    private static readonly OverallFail = 'OVERALL FAIL'
    private static readonly CrashPrefix = 'smoke crashed: '
    private static readonly InfoSigned = 'signed both image refs with key ref: '
    private static readonly InfoPublished = 'published + gated versions: '
    private static readonly InfoRunning = 'running image: '
    private static readonly VersionSep = ', '
    private static readonly Labels = {
        UpOnV1: 'k8s: environment up on v1 (Ready, running pragmatic-server:v1)',
        PushV2: 'push: SelectTarget(v2) rolls the running image to pragmatic-server:v2',
        TargetV2: 'registry: TargetFor(hive) is v2 after select',
        RollbackV1: 'rollback: SelectTarget(v1) returns the running image to pragmatic-server:v1',
        TargetV1: 'registry: TargetFor(hive) is v1 after rollback',
    }

    private failed = false
    private tempDir: string | undefined
    private tagged = false
    private readonly exec = new NodeExecFile()
    private readonly envName = RolloutPushSmoke.EnvPrefix + randomBytes(RolloutPushSmoke.SuffixBytes).toString(RolloutPushSmoke.Hex)

    public static async Main(): Promise<void>
    {
        const smoke = new RolloutPushSmoke()
        const ok = await smoke.Run()
        console.log(ok ? RolloutPushSmoke.OverallPass : RolloutPushSmoke.OverallFail)
        process.exit(ok ? 0 : 1)
    }

    public async Run(): Promise<boolean>
    {
        const S = RolloutPushSmoke
        try
        {
            this.tempDir = await mkdtemp(join(tmpdir(), S.TempDirPrefix))
            await this.TagImages()
            const dataRoot = join(this.tempDir, S.DataRootDirName)
            await this.SignBoth(dataRoot)

            const environments = new EnvironmentRegistry(this.TempFile(S.EnvironmentsFileName), new NoContainerProbe())
            const directory = new PlatformDirectory(
                new ClientRegistry(this.TempFile(S.ClientsFileName)),
                new TenantRegistry(this.TempFile(S.TenantsFileName)),
                new HiveRegistry(this.TempFile(S.HivesFileName)),
                environments)
            await directory.Load()
            await directory.CreateClient({ id: S.ClientId, displayName: S.DisplayName })
            await directory.CreateTenant({ id: S.TenantId, clientId: S.ClientId, displayName: S.DisplayName })
            const hive = await directory.CreateHive({
                id: S.HiveId,
                tenantId: S.TenantId,
                displayName: S.DisplayName,
                cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach, configRef: S.Context },
                registry: { mode: InfraMode.Attach },
                trustRootRef: S.SigningKeyRef,
            })

            const factory = new HiveOrchestratorFactory(S.Context, dataRoot)
            const registry = await this.ComposeRegistry(directory, factory, environments)
            await registry.Publish(S.VersionV1, S.ImageV1)
            await registry.Publish(S.VersionV2, S.ImageV2)
            await registry.Gate(S.TenantId, S.VersionV1)
            await registry.Gate(S.TenantId, S.VersionV2)
            console.log(S.InfoTag + S.InfoPublished + S.VersionV1 + S.VersionSep + S.VersionV2)

            const record = this.NewRecord()
            await environments.Put(record)
            const workload = this.BootWorkload(new EnvironmentPlacement(directory).WorkloadFor(record))
            const orchestrator = factory.For(hive)

            // Bring the environment up on v1 via the Deployment itself (the registry only rolls what already exists).
            await orchestrator.Apply({ ...workload, image: S.ImageV1 })
            await orchestrator.WaitHealthy(workload)
            await this.CheckRunning(orchestrator, workload, S.ImageV1, S.Labels.UpOnV1)

            await registry.SelectTarget(S.HiveId, S.VersionV2)
            await this.CheckRunning(orchestrator, workload, S.ImageV2, S.Labels.PushV2)
            this.Expect(S.Labels.TargetV2, registry.TargetFor(S.HiveId)?.version === S.VersionV2)

            await registry.SelectTarget(S.HiveId, S.VersionV1)
            await this.CheckRunning(orchestrator, workload, S.ImageV1, S.Labels.RollbackV1)
            this.Expect(S.Labels.TargetV1, registry.TargetFor(S.HiveId)?.version === S.VersionV1)
        }
        catch (err)
        {
            this.failed = true
            console.log(S.CrashPrefix + KubectlError.Redact(err instanceof Error ? err.message : String(err)))
        }
        finally
        {
            await this.Cleanup()
        }
        return !this.failed
    }

    private TempFile(name: string): string
    {
        return join(this.tempDir!, name)
    }

    private async ComposeRegistry(directory: PlatformDirectory, factory: HiveOrchestratorFactory, environments: EnvironmentRegistry): Promise<PlatformDeploymentRegistry>
    {
        const S = RolloutPushSmoke
        const manifests = new ManifestRegistry(this.TempFile(S.ManifestsFileName))
        const gating = new GatingRegistry(this.TempFile(S.GatingFileName))
        const selections = new SelectionRegistry(this.TempFile(S.SelectionsFileName))
        const reports = new RolloutReportRegistry(this.TempFile(S.ReportsFileName))
        const registrations = new RolloutRegistrationRegistry(this.TempFile(S.RegistrationsFileName))
        const observations = new HiveObservationRegistry(this.TempFile(S.ObservationsFileName))
        for (const store of [manifests, gating, selections, reports, observations, registrations])
        {
            await store.Load()
        }
        return new PlatformDeploymentRegistry(manifests, gating, selections, reports, registrations, directory, factory, environments, new EnvironmentPlacement(directory), observations)
    }

    /**
     * Two refs of the same underlying image: the roll is observable through the ref the Deployment runs. The refs are
     * then loaded into the kind node's containerd (see KindImageLoader): Docker Desktop's k8s node has its own image
     * store, so a bare host `docker tag` is invisible to it and, with IfNotPresent and no registry, a stale node copy
     * of the tag would otherwise shadow the freshly built bits.
     */
    private async TagImages(): Promise<void>
    {
        const S = RolloutPushSmoke
        this.tagged = true
        await this.exec.Run(S.Docker, [S.TagVerb, S.BaseImage, S.ImageV1])
        await this.exec.Run(S.Docker, [S.TagVerb, S.BaseImage, S.ImageV2])
        await new KindImageLoader().Load(S.ImageV1, S.ImageV2)
    }

    /** Signs both bare refs (the hive has no registry endpoint, so the effective ref is unchanged) into the factory dataRoot stores. */
    private async SignBoth(dataRoot: string): Promise<void>
    {
        const S = RolloutPushSmoke
        const keysDir = join(dataRoot, S.KeysDirName)
        await this.WriteKeyPair(keysDir, S.SigningKeyRef)
        const signer = new ImageSigner(new DockerImageDigest(), new FileSignatureStore(join(dataRoot, S.SignaturesFileName)), new FileKeyStore(keysDir))
        await signer.Sign(S.ImageV1, S.SigningKeyRef)
        await signer.Sign(S.ImageV2, S.SigningKeyRef)
        console.log(S.InfoTag + S.InfoSigned + S.SigningKeyRef)
    }

    private async CheckRunning(orchestrator: IHiveOrchestrator, workload: EnvironmentWorkload, expected: string, label: string): Promise<void>
    {
        const health = await orchestrator.Health(workload)
        console.log(RolloutPushSmoke.InfoTag + RolloutPushSmoke.InfoRunning + health.runningImage)
        this.Expect(label, health.ready && health.runningImage === expected, health.detail)
    }

    /** Writes `<ref>.pub` / `<ref>.key` PEM files in the layout FileKeyStore reads. The private PEM is never logged. */
    private async WriteKeyPair(keysDir: string, ref: string): Promise<void>
    {
        const S = RolloutPushSmoke
        await mkdir(keysDir, { recursive: true })
        const pair = generateKeyPairSync(S.Ed25519)
        await writeFile(join(keysDir, ref + FileKeyStore.PublicSuffix), pair.publicKey.export({ type: S.Spki, format: S.Pem }), S.Utf8)
        await writeFile(join(keysDir, ref + FileKeyStore.PrivateSuffix), pair.privateKey.export({ type: S.Pkcs8, format: S.Pem }), S.Utf8)
    }

    /** A throwaway dev-blank environment bound to the smoke hive, owned by the hive tenant. */
    private NewRecord(): EnvironmentRecord
    {
        const S = RolloutPushSmoke
        return {
            name: this.envName,
            type: EnvType.Development,
            template: Template.DevBlank,
            environmentId: S.TenantId,
            hiveId: S.HiveId,
            hostPort: 0,
            containerName: this.envName,
            volumeName: this.envName,
            bundleDir: S.EmptyString,
            createdAt: S.EpochIso,
            status: EnvStatus.Unknown,
        }
    }

    /** LOCAL-SMOKE-ONLY boot config (same approach as k8s-hive-smoke): throwaway random key, never logged or written to disk. */
    private BootWorkload(stock: EnvironmentWorkload): EnvironmentWorkload
    {
        const S = RolloutPushSmoke
        const boot = {
            [S.BootBaseDirKey]: S.BootBaseDir,
            [S.BootTenantKey]: this.envName,
            [S.BootMasterKeyEnvKey]: S.BootMasterKeyVar,
            [S.BootMasterKeyVar]: randomBytes(S.MasterKeyBytes).toString(S.Base64),
        }
        return { ...stock, env: { ...stock.env, ...boot } }
    }

    private async NamespaceExists(namespace: string): Promise<boolean>
    {
        const S = RolloutPushSmoke
        try
        {
            await this.exec.Run(S.Kubectl, [S.ContextFlag, S.Context, S.GetVerb, S.NamespaceKind, namespace])
            return true
        }
        catch (e)
        {
            const stderr = String((e as { stderr?: unknown }).stderr ?? S.EmptyString)
            if (stderr.includes(S.NotFoundWord))
            {
                return false
            }
            throw e
        }
    }

    /** Always-run cleanup: namespace, the two extra image tags, temp stores. */
    private async Cleanup(): Promise<void>
    {
        const S = RolloutPushSmoke
        const namespace = K8sManifestBuilder.NamespaceOf(this.envName)
        await this.BestEffort(namespace, async () =>
        {
            if (await this.NamespaceExists(namespace))
            {
                await new KubectlCli(S.Context).DeleteNamespace(namespace)
            }
        })
        if (this.tagged)
        {
            await this.BestEffort(S.ImageV1, async () => { await this.exec.Run(S.Docker, [S.ImageVerb, S.ImageV1]) })
            await this.BestEffort(S.ImageV2, async () => { await this.exec.Run(S.Docker, [S.ImageVerb, S.ImageV2]) })
        }
        if (this.tempDir !== undefined)
        {
            const dir = this.tempDir
            await this.BestEffort(dir, () => rm(dir, { recursive: true, force: true }))
        }
    }

    private async BestEffort(what: string, action: () => Promise<unknown>): Promise<void>
    {
        const S = RolloutPushSmoke
        try
        {
            await action()
        }
        catch (e)
        {
            console.log(S.TeardownWarning + what + S.DetailSep + KubectlError.Redact(e instanceof Error ? e.message : String(e)))
        }
    }

    private Expect(label: string, ok: boolean, detail: string = RolloutPushSmoke.EmptyString): void
    {
        if (!ok)
        {
            this.failed = true
        }
        const suffix = ok || detail === RolloutPushSmoke.EmptyString ? RolloutPushSmoke.EmptyString : RolloutPushSmoke.DetailSep + KubectlError.Redact(detail)
        console.log((ok ? RolloutPushSmoke.PassTag : RolloutPushSmoke.FailTag) + label + suffix)
    }

    /** True when this module is the process entry point (not when imported). */
    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
    }
}

if (RolloutPushSmoke.IsEntryPoint())
{
    await RolloutPushSmoke.Main()
}
