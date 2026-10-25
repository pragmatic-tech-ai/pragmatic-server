/**
 * GATED real-cluster smoke for in-cluster environment creation through the tenant-admin orchestration
 * path. NOT part of `tsx --test`. Requires Docker Desktop's Kubernetes (context `docker-desktop`) and the
 * `pragmatic-server:dev` image in the node's image store. Run with:
 *
 *   npx tsx admin/control-plane/in-cluster-env-create-smoke.ts
 *
 * Drives the REAL EnvironmentService in-process, wired as the standalone TenantAdminServer wires it
 * (EnvironmentRuntimeResolver -> InClusterEnvironmentRuntime, real HiveOrchestratorFactory, real
 * EnvironmentPlacement) over a SeededTenantDirectory holding one Local/Attach hive. Steps: Create (applies the
 * env-server workload, waits for rollout-Ready), endpoint is a cluster Service DNS name, Delete tears the
 * namespace down, and a same-name Recreate does not collide.
 *
 * SCOPE: orchestration level only. SP-HIVE-3 boot-config/secret injection is NOT implemented: the stock
 * workload carries only PRAGMATIC_PORT, but the served server needs a base dir, tenant source and master key.
 * Exactly as k8s-hive-smoke.ts does, this smoke injects a throwaway per-run boot config (random master key as a
 * plain env var in a throwaway namespace) via a smoke-only EnvironmentPlacement subclass so the pod can reach
 * Ready. Likewise per-env OIDC federation (Federate) is not yet in-cluster aware; the smoke supplies a stub IdP
 * service so Create's federation step does not need a docker IdP. Image provenance fails closed, so the effective
 * image ref is signed with a throwaway Ed25519 key into temp stores that the real factory reads.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DockerEnv } from '../../environments/seed/docker.js'
import { UserSeeder } from '../../environments/seed/users.js'
import { AdminProxy, WsAdminConnector } from './admin-proxy.js'
import { BundleBuilderAdapter, DockerEnvAdapter, UserSeederAdapter } from './docker-env-port.js'
import { EffectiveRegistry } from './effective-registry.js'
import { EnvironmentDtoMapper } from './environment-dto.js'
import { EnvironmentPlacement } from './environment-placement.js'
import { EnvironmentRegistry } from './environment-registry.js'
import { EnvType, Template } from './environment-record.js'
import type { EnvironmentRecord } from './environment-record.js'
import { DockerEnvironmentRuntime } from './environment-runtime.js'
import { EnvironmentRuntimeResolver } from './environment-runtime-resolver.js'
import { EnvironmentService } from './environment-service.js'
import type { EnvironmentWorkload } from './environment-workload.js'
import { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import { DockerImageDigest } from './image-digest.js'
import { ImageSigner } from './image-signer.js'
import { InClusterEnvironmentRuntime } from './in-cluster-environment-runtime.js'
import type { IdpAdminClient } from './idp-admin-client.js'
import type { IIdpService, IdpConnection } from './idp-service.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { FileKeyStore } from './key-store.js'
import { KubectlError, NodeExecFile } from './kubectl.js'
import { NetPortProbe, PortAllocator } from './port-allocator.js'
import { HiveBackend, InfraMode } from './platform-records.js'
import type { HiveRecord, TenantRecord } from './platform-records.js'
import { FileSignatureStore } from './signature-store.js'
import { SeededTenantDirectory } from './tenant-api/seeded-tenant-directory.js'

/** Smoke-only placement: the stock workload plus a throwaway boot config (the deferred SP-HIVE-3 substrate). */
class BootConfigPlacement extends EnvironmentPlacement
{
    private static readonly BootBaseDirKey = 'PRAGMATIC_BASE_DIR'
    private static readonly BootBaseDir = '/tmp/pragmatic-data'
    private static readonly BootTenantKey = 'PRAGMATIC_ENVIRONMENT_ID'
    private static readonly BootMasterKeyEnvKey = 'PRAGMATIC_MASTER_KEY_B64_ENV'
    private static readonly BootMasterKeyVar = 'SMOKE_MASTER_KEY_B64'
    private static readonly MasterKeyBytes = 32
    private static readonly Base64 = 'base64'

    public override WorkloadFor(record: EnvironmentRecord): EnvironmentWorkload
    {
        const S = BootConfigPlacement
        const stock = super.WorkloadFor(record)
        return {
            ...stock,
            env: {
                ...stock.env,
                [S.BootBaseDirKey]: S.BootBaseDir,
                [S.BootTenantKey]: record.name,
                [S.BootMasterKeyEnvKey]: S.BootMasterKeyVar,
                [S.BootMasterKeyVar]: randomBytes(S.MasterKeyBytes).toString(S.Base64),
            },
        }
    }
}

/** Smoke-only IdP stand-in: federation is not in-cluster aware yet, and the smoke must not need a docker IdP. */
class StubIdpService implements IIdpService
{
    private static readonly BaseUrl = 'https://idp.smoke.invalid'
    private static readonly Placeholder = 'smoke'

    public EnsureForTenant(_tenantId: string, _displayName: string): Promise<IdpConnection>
    {
        const S = StubIdpService
        return Promise.resolve({ baseUrl: S.BaseUrl, ca: Buffer.alloc(0), adminToken: S.Placeholder, adminTokenRef: S.Placeholder, caDir: S.Placeholder })
    }

    public static ClientFactory(): (conn: IdpConnection) => IdpAdminClient
    {
        return () => ({ RegisterClient: () => Promise.resolve() }) as unknown as IdpAdminClient
    }
}

export class InClusterEnvCreateSmoke
{
    private static readonly Context = 'docker-desktop'
    private static readonly EnvPrefix = 'icc-smoke-'
    private static readonly SuffixBytes = 3
    private static readonly Hex = 'hex'
    private static readonly HiveId = 'icc-smoke-hive'
    private static readonly TenantId = 'icc-smoke-tenant'
    private static readonly Image = 'pragmatic-server:dev'
    private static readonly KeysDirName = 'keys'
    private static readonly SignaturesFileName = 'signatures.json'
    private static readonly RegistryFileName = 'environments.json'
    private static readonly TempDirPrefix = 'icc-smoke-'
    private static readonly SigningKeyRef = 'dev-signing'
    private static readonly Ed25519 = 'ed25519'
    private static readonly Pem = 'pem'
    private static readonly Spki = 'spki'
    private static readonly Pkcs8 = 'pkcs8'
    private static readonly Utf8 = 'utf8'
    private static readonly EpochIso = '1970-01-01T00:00:00.000Z'
    private static readonly EmptyString = ''
    private static readonly EnvPortFloor = 8100
    private static readonly Kubectl = 'kubectl'
    private static readonly ContextFlag = '--context'
    private static readonly GetVerb = 'get'
    private static readonly DeleteVerb = 'delete'
    private static readonly NoWaitFlag = '--wait=false'
    private static readonly NamespaceKind = 'namespace'
    private static readonly NotFoundWord = 'NotFound'
    private static readonly TerminatingWord = 'Terminating'
    private static readonly NamespaceGoneAttempts = 60
    private static readonly NamespaceGoneIntervalMs = 2000
    private static readonly ClusterDnsSuffix = '.svc.cluster.local'
    private static readonly LocalhostMarker = 'localhost'
    private static readonly PassTag = 'PASS '
    private static readonly FailTag = 'FAIL '
    private static readonly InfoTag = 'INFO '
    private static readonly DetailSep = ' -- '
    private static readonly Space = ' '
    private static readonly TeardownWarning = 'WARN best-effort teardown failed for '
    private static readonly CleanupWarning = 'WARN temp store cleanup failed -- '
    private static readonly OverallPass = 'OVERALL PASS'
    private static readonly OverallFail = 'OVERALL FAIL'
    private static readonly CrashPrefix = 'smoke crashed: '
    private static readonly EndpointPrefix = 'endpoint='
    private static readonly Labels = {
        Create: 'create: dev-blank env bound to the hive; workload applied and rollout Ready',
        Registered: 'create: record carries hiveId/tenantId and is listed',
        Namespace: 'create: namespace exists in the cluster',
        Endpoint: 'endpoint: ToDto returns a Service DNS endpoint, not localhost',
        Delete: 'delete: EnvironmentService.Delete completes',
        Gone: 'delete: namespace gone or terminating',
        Recreate: 'recreate: same name Create succeeds after Delete (no collision)',
        RecreateReady: 'recreate: namespace exists again',
        FinalDelete: 'cleanup: final Delete completes',
    }

    private static readonly EnvName = InClusterEnvCreateSmoke.EnvPrefix + randomBytes(InClusterEnvCreateSmoke.SuffixBytes).toString(InClusterEnvCreateSmoke.Hex)

    private failed = false
    private tempDir: string | undefined

    public static async Main(): Promise<void>
    {
        const ok = await new InClusterEnvCreateSmoke().Run()
        console.log(ok ? InClusterEnvCreateSmoke.OverallPass : InClusterEnvCreateSmoke.OverallFail)
        process.exit(ok ? 0 : 1)
    }

    public async Run(): Promise<boolean>
    {
        const S = InClusterEnvCreateSmoke
        const namespace = K8sManifestBuilder.NamespaceOf(S.EnvName)
        let service: EnvironmentService | undefined
        let created = false
        try
        {
            service = await this.ComposeService()
            const record = await service.Create(S.EnvName, Template.DevBlank, EnvType.Development, undefined, S.HiveId)
            created = true
            this.Expect(S.Labels.Create, true)
            this.Expect(S.Labels.Registered, record.hiveId === S.HiveId && record.tenantId === S.TenantId && service.List().some(r => r.name === S.EnvName))
            this.Expect(S.Labels.Namespace, (await this.GetNamespace(namespace)) !== undefined)

            const dto = EnvironmentDtoMapper.ToDto(service.List().find(r => r.name === S.EnvName) as EnvironmentRecord)
            console.log(S.InfoTag + S.EndpointPrefix + dto.httpUrl + S.Space + dto.wsUrl)
            this.Expect(S.Labels.Endpoint, dto.httpUrl.includes(S.ClusterDnsSuffix) && dto.wsUrl.includes(S.ClusterDnsSuffix)
                && !dto.httpUrl.includes(S.LocalhostMarker) && !dto.wsUrl.includes(S.LocalhostMarker))

            await service.Delete(S.EnvName)
            created = false
            this.Expect(S.Labels.Delete, true)
            const afterDelete = await this.GetNamespace(namespace)
            this.Expect(S.Labels.Gone, afterDelete === undefined || afterDelete.includes(S.TerminatingWord))

            // A Terminating namespace blocks re-apply; wait for it to fully disappear before recreating.
            await this.WaitNamespaceGone(namespace)
            await service.Create(S.EnvName, Template.DevBlank, EnvType.Development, undefined, S.HiveId)
            created = true
            this.Expect(S.Labels.Recreate, true)
            this.Expect(S.Labels.RecreateReady, (await this.GetNamespace(namespace)) !== undefined)
            await service.Delete(S.EnvName)
            created = false
            this.Expect(S.Labels.FinalDelete, true)
        }
        catch (err)
        {
            this.failed = true
            console.log(S.CrashPrefix + KubectlError.Redact(err instanceof Error ? err.message : String(err)))
        }
        finally
        {
            if (created && service !== undefined)
            {
                await this.BestEffortDelete(service)
            }
            await this.BestEffortNamespaceDelete(namespace)
            await this.CleanupTempStores()
        }
        return !this.failed
    }

    /** Composes the real service as TenantAdminServer.Compose does, over temp stores and a signed image. */
    private async ComposeService(): Promise<EnvironmentService>
    {
        const S = InClusterEnvCreateSmoke
        this.tempDir = await mkdtemp(join(tmpdir(), S.TempDirPrefix))
        const dataRoot = this.tempDir
        const keysDir = join(dataRoot, S.KeysDirName)
        await this.WriteKeyPair(keysDir, S.SigningKeyRef)
        const hive = S.Hive()
        const signatures = new FileSignatureStore(join(dataRoot, S.SignaturesFileName))
        await new ImageSigner(new DockerImageDigest(), signatures, new FileKeyStore(keysDir)).Sign(EffectiveRegistry.For(hive).ImageRef(S.Image), S.SigningKeyRef)
        const directory = new SeededTenantDirectory({ tenant: S.Tenant(), hives: [hive] })
        const docker = new DockerEnvAdapter(new DockerEnv())
        const registry = new EnvironmentRegistry(join(dataRoot, S.RegistryFileName), docker)
        await registry.Load()
        const orchestrators = new HiveOrchestratorFactory(S.Context, dataRoot)
        const placement = new BootConfigPlacement(directory)
        return new EnvironmentService(
            registry,
            new PortAllocator(S.EnvPortFloor, new NetPortProbe()),
            new EnvironmentRuntimeResolver(new DockerEnvironmentRuntime(docker, new BundleBuilderAdapter()), new InClusterEnvironmentRuntime(orchestrators, placement, directory)),
            new UserSeederAdapter(new UserSeeder()),
            dataRoot,
            new AdminProxy(new WsAdminConnector()),
            directory,
            new StubIdpService(),
            StubIdpService.ClientFactory())
    }

    private async WriteKeyPair(keysDir: string, ref: string): Promise<void>
    {
        const S = InClusterEnvCreateSmoke
        await mkdir(keysDir, { recursive: true })
        const pair = generateKeyPairSync(S.Ed25519)
        await writeFile(join(keysDir, ref + FileKeyStore.PublicSuffix), pair.publicKey.export({ type: S.Spki, format: S.Pem }), S.Utf8)
        await writeFile(join(keysDir, ref + FileKeyStore.PrivateSuffix), pair.privateKey.export({ type: S.Pkcs8, format: S.Pem }), S.Utf8)
    }

    private static Tenant(): TenantRecord
    {
        const S = InClusterEnvCreateSmoke
        return { id: S.TenantId, clientId: S.TenantId, displayName: S.TenantId, createdAt: S.EpochIso }
    }

    /** A local/attach hive pointing at the docker-desktop context, trusting the throwaway signing key. */
    private static Hive(): HiveRecord
    {
        const S = InClusterEnvCreateSmoke
        return {
            id: S.HiveId,
            tenantId: S.TenantId,
            displayName: S.HiveId,
            cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach, configRef: S.Context },
            registry: { mode: InfraMode.Attach },
            trustRootRef: S.SigningKeyRef,
            createdAt: S.EpochIso,
        }
    }

    /** `kubectl get namespace` output when it exists; undefined on NotFound; any other failure is a real error. */
    private async GetNamespace(namespace: string): Promise<string | undefined>
    {
        const S = InClusterEnvCreateSmoke
        try
        {
            const out = await new NodeExecFile().Run(S.Kubectl, [S.ContextFlag, S.Context, S.GetVerb, S.NamespaceKind, namespace])
            return out.stdout
        }
        catch (e)
        {
            const stderr = String((e as { stderr?: unknown }).stderr ?? S.EmptyString)
            if (stderr.includes(S.NotFoundWord))
            {
                return undefined
            }
            throw e
        }
    }

    private async WaitNamespaceGone(namespace: string): Promise<void>
    {
        const S = InClusterEnvCreateSmoke
        for (let attempt = 0; attempt < S.NamespaceGoneAttempts; attempt++)
        {
            if (await this.GetNamespace(namespace) === undefined)
            {
                return
            }
            await new Promise<void>(resolve => setTimeout(resolve, S.NamespaceGoneIntervalMs))
        }
    }

    private async BestEffortDelete(service: EnvironmentService): Promise<void>
    {
        const S = InClusterEnvCreateSmoke
        try
        {
            await service.Delete(S.EnvName)
        }
        catch (e)
        {
            console.log(S.TeardownWarning + S.EnvName + S.DetailSep + KubectlError.Redact(e instanceof Error ? e.message : String(e)))
        }
    }

    /** Last-resort removal so a failed run never leaves the namespace behind. */
    private async BestEffortNamespaceDelete(namespace: string): Promise<void>
    {
        const S = InClusterEnvCreateSmoke
        try
        {
            if (await this.GetNamespace(namespace) !== undefined)
            {
                await new NodeExecFile().Run(S.Kubectl, [S.ContextFlag, S.Context, S.DeleteVerb, S.NamespaceKind, namespace, S.NoWaitFlag])
            }
        }
        catch (e)
        {
            console.log(S.TeardownWarning + namespace + S.DetailSep + KubectlError.Redact(e instanceof Error ? e.message : String(e)))
        }
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
            console.log(InClusterEnvCreateSmoke.CleanupWarning + KubectlError.Redact(e instanceof Error ? e.message : String(e)))
        }
    }

    private Expect(label: string, ok: boolean, detail: string = InClusterEnvCreateSmoke.EmptyString): void
    {
        const S = InClusterEnvCreateSmoke
        if (!ok)
        {
            this.failed = true
        }
        const suffix = ok || detail === S.EmptyString ? S.EmptyString : S.DetailSep + detail
        console.log((ok ? S.PassTag : S.FailTag) + label + suffix)
    }

    /** True when this module is the process entry point (not when imported). */
    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
    }
}

if (InClusterEnvCreateSmoke.IsEntryPoint())
{
    await InClusterEnvCreateSmoke.Main()
}
