/**
 * GATED real-cluster smoke for SP-HIVE-3 image provenance. NOT part of `tsx --test`.
 *
 * Requires Docker Desktop's built-in Kubernetes (context `docker-desktop`), docker, and the
 * `pragmatic-server:dev` image in the local docker image store. Run with:
 *
 *   npx tsx admin/control-plane/registry-provenance-smoke.ts
 *
 * Starts a real `registry:2` container, pushes the image to it, signs the image digest with a
 * throwaway dev Ed25519 key, then drives a real KubectlHiveOrchestrator (provision-registry hive):
 * a signed image verifies and deploys from the registry; after the signature is tampered with (and
 * separately with a wrong trust root) a further Apply is refused before anything reaches the cluster.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BundleBuilder } from '../../environments/seed/bundle.js'
import { EnvServerSeedSource } from './env-server-seed.js'
import { TemplateCatalog } from './template-catalog.js'
import { EnvironmentWorkloadFactory } from './environment-workload.js'
import type { EnvironmentWorkload } from './environment-workload.js'
import type { IHiveOrchestrator } from './hive-orchestrator.js'
import { EnvStatus, EnvType, Template } from './environment-record.js'
import type { EnvironmentRecord } from './environment-record.js'
import { EffectiveRegistry } from './effective-registry.js'
import { DockerImageDigest } from './image-digest.js'
import { ImageSigner } from './image-signer.js'
import { CryptoImageVerifier, ImageVerificationError } from './image-verifier.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { FileKeyStore } from './key-store.js'
import { KubectlCli, KubectlError, NodeExecFile } from './kubectl.js'
import { KubectlHiveOrchestrator } from './kubectl-hive-orchestrator.js'
import { HiveBackend, InfraMode } from './platform-records.js'
import type { HiveRecord } from './platform-records.js'
import { FileSignatureStore } from './signature-store.js'

export class RegistryProvenanceSmoke
{
    private static readonly Context = 'docker-desktop'
    private static readonly EnvPrefix = 'prov-smoke-'
    private static readonly SuffixBytes = 3
    private static readonly Hex = 'hex'
    private static readonly HiveId = 'prov-hive'
    private static readonly TenantId = 'prov-tenant'
    private static readonly BaseImage = 'pragmatic-server:dev'
    private static readonly RegistryEndpoint = 'localhost:5000'
    private static readonly RegistryImage = 'registry:2'
    private static readonly RegistryPortMap = '127.0.0.1:5000:5000'
    private static readonly RegistryProbeUrl = 'http://localhost:5000/v2/'
    private static readonly PathSeparator = '/'
    private static readonly ProbeAttempts = 30
    private static readonly ProbeIntervalMs = 1000
    private static readonly ContainerIdChars = 12
    private static readonly Docker = 'docker'
    private static readonly RunVerb = 'run'
    private static readonly DetachFlag = '-d'
    private static readonly PublishFlag = '-p'
    private static readonly TagVerb = 'tag'
    private static readonly PushVerb = 'push'
    private static readonly RemoveVerb = 'rm'
    private static readonly ImageVerb = 'rmi'
    private static readonly ForceFlag = '-f'
    private static readonly Kubectl = 'kubectl'
    private static readonly ContextFlag = '--context'
    private static readonly GetVerb = 'get'
    private static readonly NamespaceKind = 'namespace'
    private static readonly NotFoundWord = 'NotFound'
    private static readonly KeysDirName = 'keys'
    private static readonly SignaturesFileName = 'signatures.json'
    private static readonly TempDirPrefix = 'prov-smoke-'
    private static readonly SigningKeyRef = 'dev-signing'
    private static readonly WrongKeyRef = 'dev-wrong'
    private static readonly Ed25519 = 'ed25519'
    private static readonly Pem = 'pem'
    private static readonly Spki = 'spki'
    private static readonly Pkcs8 = 'pkcs8'
    private static readonly Utf8 = 'utf8'
    private static readonly EpochIso = '1970-01-01T00:00:00.000Z'
    private static readonly EmptyString = ''
    private static readonly SeedDirPrefix = 'registry-smoke-seed-'
    private static readonly TamperedSignature = 'AAAA'
    private static readonly PassTag = 'PASS '
    private static readonly FailTag = 'FAIL '
    private static readonly DetailSep = ' -- '
    private static readonly InfoTag = 'INFO '
    private static readonly TeardownWarning = 'WARN best-effort teardown failed for '
    private static readonly OverallPass = 'OVERALL PASS'
    private static readonly OverallFail = 'OVERALL FAIL'
    private static readonly CrashPrefix = 'smoke crashed: '
    private static readonly RegistryNotReady = 'registry did not become ready at '
    private static readonly InfoRegistryUp = 'registry container started: '
    private static readonly InfoPushed = 'pushed image: '
    private static readonly InfoSigned = 'signed image digest with key ref: '
    private static readonly InfoApplyRefused = 'Apply refused: '
    private static readonly Labels = {
        Verified: 'provenance: signed registry image verifies and Apply succeeds',
        Healthy: 'k8s: WaitHealthy (pod Ready)',
        RunningImage: 'k8s: running image ref is the registry ref',
        Tamper: 'provenance: tampered signature -> Apply throws ImageVerificationError',
        NotApplied: 'provenance: refused Apply created no namespace',
        WrongKey: 'provenance: wrong trust root -> Apply throws ImageVerificationError',
        WrongKeyNotApplied: 'provenance: wrong-trust-root Apply created no namespace',
    }

    private failed = false
    private containerId: string | undefined
    private tempDir: string | undefined
    private tagged = false
    private readonly exec = new NodeExecFile()
    private readonly namespaces: string[] = []

    public static async Main(): Promise<void>
    {
        const smoke = new RegistryProvenanceSmoke()
        const ok = await smoke.Run()
        console.log(ok ? RegistryProvenanceSmoke.OverallPass : RegistryProvenanceSmoke.OverallFail)
        process.exit(ok ? 0 : 1)
    }

    public async Run(): Promise<boolean>
    {
        const S = RegistryProvenanceSmoke
        try
        {
            this.tempDir = await mkdtemp(join(tmpdir(), S.TempDirPrefix))
            const keysDir = join(this.tempDir, S.KeysDirName)
            const sigPath = join(this.tempDir, S.SignaturesFileName)
            await this.WriteKeyPair(keysDir, S.SigningKeyRef)
            await this.WriteKeyPair(keysDir, S.WrongKeyRef)
            await this.ProvisionRegistry()
            const keys = new FileKeyStore(keysDir)
            const signatures = new FileSignatureStore(sigPath)
            await new ImageSigner(new DockerImageDigest(), signatures, keys).Sign(S.RegistryRef(), S.SigningKeyRef)
            console.log(S.InfoTag + S.InfoSigned + S.SigningKeyRef)

            const verifier = new CryptoImageVerifier(new DockerImageDigest(), signatures, keys)
            const good = this.Orchestrator(verifier, S.SigningKeyRef)
            await this.CheckPasses(good)
            // Order matters: the wrong-key check runs while the stored signature is still valid for the real key.
            await this.CheckWrongKey(this.Orchestrator(verifier, S.WrongKeyRef))
            await this.CheckTampered(good, sigPath)
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

    private static RegistryRef(): string
    {
        return RegistryProvenanceSmoke.RegistryEndpoint + RegistryProvenanceSmoke.PathSeparator + RegistryProvenanceSmoke.BaseImage
    }

    private Orchestrator(verifier: CryptoImageVerifier, trustRootRef: string): KubectlHiveOrchestrator
    {
        const S = RegistryProvenanceSmoke
        return new KubectlHiveOrchestrator(
            new KubectlCli(S.Context),
            new K8sManifestBuilder(),
            EffectiveRegistry.For(S.Hive()),
            verifier,
            trustRootRef)
    }

    /** Signed image: verify passes, the pod pulls from the registry and reaches Ready. */
    private async CheckPasses(orchestrator: KubectlHiveOrchestrator): Promise<void>
    {
        const S = RegistryProvenanceSmoke
        const workload = this.NewWorkload()
        await orchestrator.Apply(workload)
        this.Expect(S.Labels.Verified, true)
        await this.ApplySeed(orchestrator, workload.environmentName)
        await orchestrator.WaitHealthy(workload)
        this.Expect(S.Labels.Healthy, true)
        const health = await orchestrator.Health(workload)
        this.Expect(S.Labels.RunningImage, health.ready && health.runningImage === S.RegistryRef(), health.detail)
    }

    /** Corrupts the stored signature; a fresh-namespace Apply must be refused before kubectl apply. */
    private async CheckTampered(orchestrator: KubectlHiveOrchestrator, sigPath: string): Promise<void>
    {
        const S = RegistryProvenanceSmoke
        const map = JSON.parse(await readFile(sigPath, S.Utf8)) as Record<string, string>
        for (const digest of Object.keys(map))
        {
            map[digest] = S.TamperedSignature
        }
        await writeFile(sigPath, JSON.stringify(map), S.Utf8)
        await this.ExpectRefused(orchestrator, S.Labels.Tamper, S.Labels.NotApplied)
    }

    private async CheckWrongKey(orchestrator: KubectlHiveOrchestrator): Promise<void>
    {
        const S = RegistryProvenanceSmoke
        await this.ExpectRefused(orchestrator, S.Labels.WrongKey, S.Labels.WrongKeyNotApplied)
    }

    private async ExpectRefused(orchestrator: KubectlHiveOrchestrator, refusedLabel: string, absentLabel: string): Promise<void>
    {
        const S = RegistryProvenanceSmoke
        const workload = this.NewWorkload()
        let refused = false
        try
        {
            await orchestrator.Apply(workload)
        }
        catch (e)
        {
            refused = e instanceof ImageVerificationError
            console.log(S.InfoTag + S.InfoApplyRefused + KubectlError.Redact(e instanceof Error ? e.message : String(e)))
        }
        this.Expect(refusedLabel, refused)
        this.Expect(absentLabel, !(await this.NamespaceExists(K8sManifestBuilder.NamespaceOf(workload.environmentName))))
    }

    /** Starts registry:2, waits for /v2/, then tags and pushes the dev image into it. */
    private async ProvisionRegistry(): Promise<void>
    {
        const S = RegistryProvenanceSmoke
        const run = await this.exec.Run(S.Docker, [S.RunVerb, S.DetachFlag, S.PublishFlag, S.RegistryPortMap, S.RegistryImage])
        this.containerId = run.stdout.trim()
        console.log(S.InfoTag + S.InfoRegistryUp + this.containerId.slice(0, S.ContainerIdChars))
        await this.WaitRegistry()
        await this.exec.Run(S.Docker, [S.TagVerb, S.BaseImage, S.RegistryRef()])
        this.tagged = true
        await this.exec.Run(S.Docker, [S.PushVerb, S.RegistryRef()])
        console.log(S.InfoTag + S.InfoPushed + S.RegistryRef())
    }

    private async WaitRegistry(): Promise<void>
    {
        const S = RegistryProvenanceSmoke
        for (let attempt = 0; attempt < S.ProbeAttempts; attempt++)
        {
            try
            {
                const res = await fetch(S.RegistryProbeUrl)
                if (res.ok)
                {
                    return
                }
            }
            catch
            {
                // not listening yet
            }
            await new Promise<void>(resolve => setTimeout(resolve, S.ProbeIntervalMs))
        }
        throw new Error(S.RegistryNotReady + S.RegistryProbeUrl)
    }

    /** Writes `<ref>.pub` / `<ref>.key` PEM files in the layout FileKeyStore reads. The private PEM is never logged. */
    private async WriteKeyPair(keysDir: string, ref: string): Promise<void>
    {
        const S = RegistryProvenanceSmoke
        await mkdir(keysDir, { recursive: true })
        const pair = generateKeyPairSync(S.Ed25519)
        await writeFile(join(keysDir, ref + FileKeyStore.PublicSuffix), pair.publicKey.export({ type: S.Spki, format: S.Pem }), S.Utf8)
        await writeFile(join(keysDir, ref + FileKeyStore.PrivateSuffix), pair.privateKey.export({ type: S.Pkcs8, format: S.Pem }), S.Utf8)
    }

    /** A throwaway dev-blank environment with a per-run random name, derived as production derives it. */
    private NewWorkload(): EnvironmentWorkload
    {
        const S = RegistryProvenanceSmoke
        const name = S.EnvPrefix + randomBytes(S.SuffixBytes).toString(S.Hex)
        this.namespaces.push(K8sManifestBuilder.NamespaceOf(name))
        const record: EnvironmentRecord = {
            name,
            type: EnvType.Development,
            template: Template.DevBlank,
            environmentId: name,
            hiveId: S.HiveId,
            hostPort: 0,
            containerName: name,
            volumeName: name,
            bundleDir: S.EmptyString,
            createdAt: S.EpochIso,
            status: EnvStatus.Unknown,
        }
        return EnvironmentWorkloadFactory.From(record, S.Hive())
    }

    /** Applies the real env-server seed (tenants ConfigMap + Secrets) exactly as InClusterEnvironmentRuntime.BringUp does. */
    private async ApplySeed(orchestrator: IHiveOrchestrator, environmentName: string): Promise<void>
    {
        const S = RegistryProvenanceSmoke
        const { def, seedDir } = TemplateCatalog.Resolve(Template.DevBlank, environmentName, 0, EnvType.Development)
        const bundleDir = await mkdtemp(join(tmpdir(), S.SeedDirPrefix))
        try
        {
            await BundleBuilder.Generate(def, bundleDir, seedDir)
            await EnvServerSeedSource.ApplyBundle(orchestrator.Kubectl, bundleDir, environmentName)
        }
        finally
        {
            await rm(bundleDir, { recursive: true, force: true })
        }
    }

    /** A local/attach cluster hive whose registry is provisioned (resolves to localhost:5000). */
    private static Hive(): HiveRecord
    {
        const S = RegistryProvenanceSmoke
        return {
            id: S.HiveId,
            tenantId: S.TenantId,
            displayName: S.HiveId,
            cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach, configRef: S.Context },
            registry: { mode: InfraMode.Provision },
            createdAt: S.EpochIso,
        }
    }

    private async NamespaceExists(namespace: string): Promise<boolean>
    {
        const S = RegistryProvenanceSmoke
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

    /** Always-run cleanup: namespaces, registry container, temp key/signature stores. */
    private async Cleanup(): Promise<void>
    {
        const S = RegistryProvenanceSmoke
        const cluster = new KubectlCli(S.Context)
        for (const ns of this.namespaces)
        {
            await this.BestEffort(ns, () => cluster.DeleteNamespace(ns))
        }
        if (this.containerId !== undefined)
        {
            const id = this.containerId
            await this.BestEffort(id.slice(0, S.ContainerIdChars), async () => { await this.exec.Run(S.Docker, [S.RemoveVerb, S.ForceFlag, id]) })
        }
        if (this.tagged)
        {
            await this.BestEffort(S.RegistryRef(), async () => { await this.exec.Run(S.Docker, [S.ImageVerb, S.RegistryRef()]) })
        }
        if (this.tempDir !== undefined)
        {
            const dir = this.tempDir
            await this.BestEffort(dir, () => rm(dir, { recursive: true, force: true }))
        }
    }

    private async BestEffort(what: string, action: () => Promise<unknown>): Promise<void>
    {
        const S = RegistryProvenanceSmoke
        try
        {
            await action()
        }
        catch (e)
        {
            console.log(S.TeardownWarning + what + S.DetailSep + KubectlError.Redact(e instanceof Error ? e.message : String(e)))
        }
    }

    private Expect(label: string, ok: boolean, detail: string = RegistryProvenanceSmoke.EmptyString): void
    {
        if (!ok)
        {
            this.failed = true
        }
        const suffix = ok || detail === RegistryProvenanceSmoke.EmptyString ? RegistryProvenanceSmoke.EmptyString : RegistryProvenanceSmoke.DetailSep + KubectlError.Redact(detail)
        console.log((ok ? RegistryProvenanceSmoke.PassTag : RegistryProvenanceSmoke.FailTag) + label + suffix)
    }

    /** True when this module is the process entry point (not when imported). */
    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
    }
}

if (RegistryProvenanceSmoke.IsEntryPoint())
{
    await RegistryProvenanceSmoke.Main()
}
