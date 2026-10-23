/**
 * GATED real-cluster smoke for the kind (Local + Provision) Hive Orchestrator. NOT part of `tsx --test`
 * and NOT part of `npm test`.
 *
 * Requires the real `kind` CLI on PATH, a running Docker daemon, and the `pragmatic-server:dev` image
 * in the local docker image store. Run manually with:
 *
 *   npx tsx admin/control-plane/kind-hive-smoke.ts
 *
 * Stands up TWO provisioned kind clusters (distinct hives), loads the dev image onto each node (kind
 * nodes do NOT share the host docker image store), applies a throwaway dev-blank workload to each,
 * proves both are independently healthy and isolated, then destroys both clusters. Provenance-aware
 * like k8s-hive-smoke.ts: the image ref is signed with a throwaway dev Ed25519 key (temp stores) and
 * the factory is composed over that data root. The registry is attach-style (no endpoint) so the image
 * ref is left unchanged -- a kind node cannot reach the provision-registry localhost:5000 default.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EnvironmentWorkloadFactory } from './environment-workload.js'
import type { EnvironmentWorkload } from './environment-workload.js'
import { EnvStatus, EnvType, Template } from './environment-record.js'
import type { EnvironmentRecord } from './environment-record.js'
import { EffectiveRegistry } from './effective-registry.js'
import { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import { DockerImageDigest } from './image-digest.js'
import { ImageSigner } from './image-signer.js'
import { FileKeyStore } from './key-store.js'
import { KindCli } from './kind.js'
import { KindClusterName } from './kind-cluster-name.js'
import { KindHiveOrchestrator } from './kind-hive-orchestrator.js'
import { KubectlError, NodeExecFile } from './kubectl.js'
import { HiveBackend, InfraMode } from './platform-records.js'
import type { HiveRecord } from './platform-records.js'
import { FileSignatureStore } from './signature-store.js'

/** One provisioned hive under test: its record, workload and resolved orchestrator. */
class SmokeHive
{
    public constructor(
        public readonly id: string,
        public readonly workload: EnvironmentWorkload,
        public readonly orchestrator: KindHiveOrchestrator,
    )
    {
    }
}

export class KindHiveSmoke
{
    private static readonly SuffixBytes = 2
    private static readonly Hex = 'hex'
    /** Per-run suffix so a run never collides with (or destroys) a pre-existing cluster. */
    private static readonly RunSuffix = randomBytes(KindHiveSmoke.SuffixBytes).toString(KindHiveSmoke.Hex)
    private static readonly HiveIdA = 'ks-a-' + KindHiveSmoke.RunSuffix
    private static readonly HiveIdB = 'ks-b-' + KindHiveSmoke.RunSuffix
    private static readonly TenantId = 'smoke-tenant'
    private static readonly EnvPrefix = 'kind-smoke-'
    private static readonly Image = 'pragmatic-server:dev'
    private static readonly KeysDirName = 'keys'
    private static readonly SignaturesFileName = 'signatures.json'
    private static readonly TempDirPrefix = 'kind-smoke-prov-'
    private static readonly SigningKeyRef = 'dev-signing'
    private static readonly Ed25519 = 'ed25519'
    private static readonly Pem = 'pem'
    private static readonly Spki = 'spki'
    private static readonly Pkcs8 = 'pkcs8'
    private static readonly Utf8 = 'utf8'
    private static readonly Base64 = 'base64'
    private static readonly InfoTag = 'INFO '
    private static readonly InfoSigned = 'signed effective image ref with key ref: '
    private static readonly CleanupWarning = 'WARN temp key/signature store cleanup failed -- '
    private static readonly EpochIso = '1970-01-01T00:00:00.000Z'
    private static readonly EmptyString = ''
    private static readonly BootBaseDirKey = 'PRAGMATIC_BASE_DIR'
    private static readonly BootBaseDir = '/tmp/pragmatic-data'
    private static readonly BootTenantKey = 'PRAGMATIC_TENANT_ID'
    private static readonly BootMasterKeyEnvKey = 'PRAGMATIC_MASTER_KEY_B64_ENV'
    private static readonly BootMasterKeyVar = 'SMOKE_MASTER_KEY_B64'
    private static readonly MasterKeyBytes = 32
    private static readonly PassTag = 'PASS '
    private static readonly FailTag = 'FAIL '
    private static readonly IdSep = ': '
    private static readonly ListSep = '; '
    private static readonly DetailSep = ' -- '
    private static readonly DestroyWarning = 'WARN best-effort cluster destroy failed for '
    private static readonly OverallPass = 'OVERALL PASS'
    private static readonly OverallFail = 'OVERALL FAIL'
    private static readonly CrashPrefix = 'smoke crashed: '
    private static readonly NotKindOrchestrator = 'factory did not resolve a KindHiveOrchestrator for hive '
    private static readonly Labels = {
        Apply: 'kind: Apply schedules the workload on the pre-created cluster for both hives',
        Loaded: 'kind: clusters pre-created + image loaded onto both nodes',
        Healthy: 'kind: WaitHealthy completes for both hives',
        Ready: 'kind: Health reports ready on the requested image for both hives',
        Distinct: 'kind: the two hives map to two distinct cluster names',
        Listed: 'kind: both distinct clusters are present in ListClusters',
        Destroyed: 'kind: DestroyCluster completes for both hives',
        Gone: 'kind: ListClusters no longer contains either cluster after teardown',
    }

    private failed = false
    private tempDir: string | undefined

    public static async Main(): Promise<void>
    {
        const smoke = new KindHiveSmoke()
        const ok = await smoke.Run()
        console.log(ok ? KindHiveSmoke.OverallPass : KindHiveSmoke.OverallFail)
        process.exit(ok ? 0 : 1)
    }

    public async Run(): Promise<boolean>
    {
        const S = KindHiveSmoke
        const kind = new KindCli(new NodeExecFile())
        const hives: SmokeHive[] = []
        let destroyed = false
        try
        {
            const factory = await this.SignedFactory()
            hives.push(this.Resolve(factory, S.HiveIdA), this.Resolve(factory, S.HiveIdB))
            // kind nodes do not share the host image store: pre-create each cluster and load the image
            // onto its node BEFORE scheduling, so the pod never hits ImagePullBackOff. Apply's idempotent
            // EnsureCluster then finds the cluster and only schedules the workload.
            for (const hive of hives)
            {
                await kind.CreateCluster(hive.orchestrator.ClusterName)
                await kind.LoadImage(S.Image, hive.orchestrator.ClusterName)
            }
            this.Expect(S.Labels.Loaded, true)
            for (const hive of hives)
            {
                await hive.orchestrator.Apply(hive.workload)
            }
            this.Expect(S.Labels.Apply, true)
            for (const hive of hives)
            {
                await hive.orchestrator.WaitHealthy(hive.workload)
            }
            this.Expect(S.Labels.Healthy, true)
            await this.CheckReady(hives)
            await this.CheckIsolated(kind, hives)
            for (const hive of hives)
            {
                await hive.orchestrator.DestroyCluster()
            }
            destroyed = true
            this.Expect(S.Labels.Destroyed, true)
            const remaining = await kind.ListClusters()
            this.Expect(S.Labels.Gone, hives.every(h => !remaining.includes(h.orchestrator.ClusterName)))
        }
        catch (err)
        {
            this.failed = true
            console.log(S.CrashPrefix + KubectlError.Redact(err instanceof Error ? err.message : String(err)))
        }
        finally
        {
            if (!destroyed)
            {
                await this.BestEffortDestroy(hives, [S.HiveIdA, S.HiveIdB])
            }
            await this.CleanupTempStores()
        }
        return !this.failed
    }

    private async CheckReady(hives: readonly SmokeHive[]): Promise<void>
    {
        let ok = true
        const details: string[] = []
        for (const hive of hives)
        {
            const health = await hive.orchestrator.Health(hive.workload)
            if (!(health.ready && health.runningImage === KindHiveSmoke.Image))
            {
                ok = false
                details.push(hive.id + KindHiveSmoke.IdSep + health.detail)
            }
        }
        this.Expect(KindHiveSmoke.Labels.Ready, ok, details.join(KindHiveSmoke.ListSep))
    }

    private async CheckIsolated(kind: KindCli, hives: readonly SmokeHive[]): Promise<void>
    {
        const S = KindHiveSmoke
        const names = hives.map(h => h.orchestrator.ClusterName)
        this.Expect(S.Labels.Distinct, new Set(names).size === names.length)
        const listed = await kind.ListClusters()
        this.Expect(S.Labels.Listed, names.every(n => listed.includes(n)))
    }

    /**
     * Signs the effective image ref into temp stores and returns a factory whose fail-closed verifier
     * reads them. Both hives share the signing key ref (their trustRootRef) and the attach registry.
     */
    private async SignedFactory(): Promise<HiveOrchestratorFactory>
    {
        const S = KindHiveSmoke
        this.tempDir = await mkdtemp(join(tmpdir(), S.TempDirPrefix))
        const keysDir = join(this.tempDir, S.KeysDirName)
        await this.WriteKeyPair(keysDir, S.SigningKeyRef)
        const keys = new FileKeyStore(keysDir)
        const signatures = new FileSignatureStore(join(this.tempDir, S.SignaturesFileName))
        const effective = EffectiveRegistry.For(S.Hive(S.HiveIdA))
        await new ImageSigner(new DockerImageDigest(), signatures, keys).Sign(effective.ImageRef(S.Image), S.SigningKeyRef)
        console.log(S.InfoTag + S.InfoSigned + S.SigningKeyRef)
        return new HiveOrchestratorFactory(undefined, this.tempDir)
    }

    private Resolve(factory: HiveOrchestratorFactory, hiveId: string): SmokeHive
    {
        const record = KindHiveSmoke.Hive(hiveId)
        const orchestrator = factory.For(record)
        if (!(orchestrator instanceof KindHiveOrchestrator))
        {
            throw new Error(KindHiveSmoke.NotKindOrchestrator + hiveId)
        }
        return new SmokeHive(hiveId, KindHiveSmoke.Workload(record), orchestrator)
    }

    /** Writes `<ref>.pub` / `<ref>.key` PEM files in the layout FileKeyStore reads. The private PEM is never logged. */
    private async WriteKeyPair(keysDir: string, ref: string): Promise<void>
    {
        const S = KindHiveSmoke
        await mkdir(keysDir, { recursive: true })
        const pair = generateKeyPairSync(S.Ed25519)
        await writeFile(join(keysDir, ref + FileKeyStore.PublicSuffix), pair.publicKey.export({ type: S.Spki, format: S.Pem }), S.Utf8)
        await writeFile(join(keysDir, ref + FileKeyStore.PrivateSuffix), pair.privateKey.export({ type: S.Pkcs8, format: S.Pem }), S.Utf8)
    }

    private async CleanupTempStores(): Promise<void>
    {
        if (this.tempDir === undefined)
        {
            return
        }
        try
        {
            await rm(this.tempDir, { recursive: true, force: true })
        }
        catch (e)
        {
            console.log(KindHiveSmoke.CleanupWarning + KubectlError.Redact(e instanceof Error ? e.message : String(e)))
        }
    }

    /** A provisioned local hive with an attach-style registry (no endpoint => image ref unchanged). */
    private static Hive(hiveId: string): HiveRecord
    {
        const S = KindHiveSmoke
        return {
            id: hiveId,
            tenantId: S.TenantId,
            displayName: hiveId,
            cluster: { backend: HiveBackend.Local, mode: InfraMode.Provision },
            registry: { mode: InfraMode.Attach },
            trustRootRef: S.SigningKeyRef,
            createdAt: S.EpochIso,
        }
    }

    /** A throwaway dev-blank environment, derived exactly as production derives it (no database for dev-blank). */
    private static Workload(hive: HiveRecord): EnvironmentWorkload
    {
        const S = KindHiveSmoke
        const name = S.EnvPrefix + hive.id
        const record: EnvironmentRecord = {
            name,
            type: EnvType.Development,
            template: Template.DevBlank,
            environmentId: name,
            hiveId: hive.id,
            hostPort: 0,
            containerName: name,
            volumeName: name,
            bundleDir: S.EmptyString,
            createdAt: S.EpochIso,
            status: EnvStatus.Unknown,
        }
        const stock = EnvironmentWorkloadFactory.From(record, hive)
        return { ...stock, env: { ...stock.env, ...S.BootEnv(name) } }
    }

    /**
     * LOCAL-SMOKE-ONLY boot config (same rationale as k8s-hive-smoke.ts): a throwaway random master key
     * as a plain env var in a throwaway cluster so the pod can reach Ready. Generated per run, never
     * logged, never written to disk.
     */
    private static BootEnv(tenant: string): Record<string, string>
    {
        const S = KindHiveSmoke
        return {
            [S.BootBaseDirKey]: S.BootBaseDir,
            [S.BootTenantKey]: tenant,
            [S.BootMasterKeyEnvKey]: S.BootMasterKeyVar,
            [S.BootMasterKeyVar]: randomBytes(S.MasterKeyBytes).toString(S.Base64),
        }
    }

    /** Failure-path cleanup so a crashed run never leaks real kind clusters. Destroys by derived name even if resolution failed. */
    private async BestEffortDestroy(hives: readonly SmokeHive[], hiveIds: readonly string[]): Promise<void>
    {
        const S = KindHiveSmoke
        const kind = new KindCli(new NodeExecFile())
        for (const id of hiveIds)
        {
            const name = KindClusterName.For(id)
            try
            {
                const known = hives.find(h => h.orchestrator.ClusterName === name)
                if (known !== undefined)
                {
                    await known.orchestrator.DestroyCluster()
                }
                else
                {
                    await kind.DeleteCluster(name)
                }
            }
            catch (e)
            {
                console.log(S.DestroyWarning + name + S.DetailSep + KubectlError.Redact(e instanceof Error ? e.message : String(e)))
            }
        }
    }

    private Expect(label: string, ok: boolean, detail: string = KindHiveSmoke.EmptyString): void
    {
        if (!ok)
        {
            this.failed = true
        }
        const suffix = ok || detail === KindHiveSmoke.EmptyString ? KindHiveSmoke.EmptyString : KindHiveSmoke.DetailSep + detail
        console.log((ok ? KindHiveSmoke.PassTag : KindHiveSmoke.FailTag) + label + suffix)
    }

    /** True when this module is the process entry point (not when imported). */
    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
    }
}

if (KindHiveSmoke.IsEntryPoint())
{
    await KindHiveSmoke.Main()
}
