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
 * SP-HIVE-3 boot-config/secret injection is now LIVE: Create runs the real InClusterEnvironmentRuntime path
 * (Prepare generates the per-env bundle under the control-plane data root; BringUp applies the tenants ConfigMap
 * and the master-key/provisioned-secrets k8s Secrets alongside the workload), so the pod reaches rollout-Ready
 * purely from the injected config — no throwaway placement, no plaintext master-key env var.
 * In-cluster create does NOT federate (per-env OIDC federation is deferred in-cluster), so NO IdP is
 * contacted; an UncontactedIdpService guard proves it (any federation attempt would throw and fail the smoke).
 * SP-HIVE-3b adds a DEMO phase (Template.DemoContoso): Create projects the contoso seed tree (identity, packages,
 * applications incl. northwind) into the `<env>-env-seed` Secret, the server pod's init-container unpacks it into
 * `data/contoso/` (marker `.env-seeded`), and over a `kubectl port-forward` tunnel + the tenant WS the smoke asserts
 * northwind is registered and its graph is queryable (reads succeed under app-private governance). It then writes a
 * live-data probe file, restarts the pod (init-container re-runs) and asserts the marker and probe survive, i.e. a
 * restart does NOT re-seed. OPERATOR-RUN ONLY: it needs a live docker-desktop cluster and is never executed by CI.
 * Image provenance fails closed, so the effective image ref is signed with a throwaway Ed25519 key into temp stores
 * that the real factory reads.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import { BundleBuilder } from '../../environments/seed/bundle.js'
import { NorthwindApp } from '../../environments/seed/compile.js'
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

/**
 * In-cluster create does NOT federate (per-env OIDC federation is deferred in-cluster), so no IdP is contacted. This
 * guard proves it: were federation ever reached, the call would throw and fail the smoke. The smoke needs no docker IdP.
 */
class UncontactedIdpService implements IIdpService
{
    private static readonly Message = 'in-cluster create must not contact the IdP: federation is deferred in-cluster'

    public EnsureForTenant(_tenantId: string, _displayName: string): Promise<IdpConnection>
    {
        return Promise.reject(new Error(UncontactedIdpService.Message))
    }

    public static ClientFactory(): (conn: IdpConnection) => IdpAdminClient
    {
        return () =>
        {
            throw new Error(UncontactedIdpService.Message)
        }
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
    private static readonly DemoEnvPrefix = 'icc-demo-'
    private static readonly DemoEnvironmentId = 'contoso'
    private static readonly SecretsFileName = 'provisioned-secrets.json'
    private static readonly ExecVerb = 'exec'
    private static readonly RolloutVerb = 'rollout'
    private static readonly RestartVerb = 'restart'
    private static readonly StatusVerb = 'status'
    private static readonly PortForwardVerb = 'port-forward'
    private static readonly NamespaceFlag = '-n'
    private static readonly PvcKind = 'pvc'
    private static readonly SecretKind = 'secret'
    private static readonly NameOutput = '-o=name'
    private static readonly ReadyReplicasPath = '-o=jsonpath={.status.readyReplicas}'
    private static readonly DeploymentKind = 'deployment'
    private static readonly ZeroReplicas = 0
    private static readonly OneReplica = 1
    private static readonly ReplicaAttempts = 60
    private static readonly ReplicaIntervalMs = 2000
    private static readonly HealthzPath = '/healthz'
    private static readonly ContainerFlag = '-c'
    private static readonly ArgSeparator = '--'
    private static readonly DeploymentPrefix = 'deployment/'
    private static readonly ShellBinary = 'sh'
    private static readonly ShellEvalFlag = '-c'
    private static readonly TestFileCommand = 'test -f '
    private static readonly WriteProbeCommand = 'echo '
    private static readonly RedirectOperator = ' > '
    private static readonly DataMount = '/pragmatic/data'
    private static readonly SeedMarkerName = '.env-seeded'
    private static readonly LiveProbeName = 'live-probe.txt'
    private static readonly LiveProbeValue = 'live-data-must-survive-restart'
    private static readonly PathSeparator = '/'
    private static readonly LocalPortBase = 18000
    private static readonly LocalPortSpread = 1000
    private static readonly ServerPort = 8080
    private static readonly PortMapSeparator = ':'
    private static readonly ForwardingBanner = 'Forwarding from'
    private static readonly DataEvent = 'data'
    private static readonly ErrorEvent = 'error'
    private static readonly Utf8Encoding = 'utf8'
    private static readonly SigTerm = 'SIGTERM'
    private static readonly ForwardTimeoutMs = 30000
    private static readonly ForwardTimeoutMessage = 'port-forward did not become ready in time'
    private static readonly LoopbackHttp = 'http://127.0.0.1:'
    private static readonly LoopbackWs = 'ws://127.0.0.1:'
    private static readonly WsQuerySeparator = '/?environment='
    private static readonly OrdersQuery = 'MATCH (o:Order) RETURN o'
    private static readonly OrdersInfo = 'northwind orders visible to the env admin: '
    private static readonly Comma = ','
    private static readonly NoSecretMessage = 'provisioned-secrets.json has no entry for '
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
        DemoCreate: 'demo: Create (Template.DemoContoso) on the hive completes and rolls out Ready',
        DemoMarker: 'demo: seed marker .env-seeded present under data/contoso (init-container projected the tree)',
        DemoNorthwindRegistered: 'demo: northwind is registered and lists as an application over the tenant WS',
        DemoNorthwindQuery: 'demo: northwind graph is queryable (Cypher read succeeds under app-private governance)',
        DemoLiveWrite: 'demo: live-data probe written into the data dir',
        DemoNoReseedMarker: 'demo: after restart the .env-seeded marker is intact (no re-seed)',
        DemoNoReseedLive: 'demo: after restart the live-data probe survived (seed did not clobber live state)',
        StopScaled: 'stop: server Deployment scaled to 0 ready replicas (pod gone)',
        StopRetained: 'stop: namespace, data PVC and env Secrets still exist (nothing torn down)',
        StartBack: 'start: server Deployment back to 1 ready replica',
        StartHealthy: 'start: /healthz answers OK through the tunnel',
        StartDataKept: 'start: live-data probe written before Stop survived (PVC data preserved)',
        DemoDelete: 'demo: Delete completes',
    }

    private static readonly EnvName = InClusterEnvCreateSmoke.EnvPrefix + randomBytes(InClusterEnvCreateSmoke.SuffixBytes).toString(InClusterEnvCreateSmoke.Hex)

    private failed = false
    private tempDir: string | undefined
    private forward: ChildProcess | undefined
    private readonly clients: PragmaticClient[] = []

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
        const demoName = S.DemoEnvPrefix + randomBytes(S.SuffixBytes).toString(S.Hex)
        const demoNamespace = K8sManifestBuilder.NamespaceOf(demoName)
        let demoCreated = false
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

            demoCreated = true
            await this.RunDemoPhase(service, demoName, demoNamespace)
            demoCreated = false
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
            if (demoCreated && service !== undefined)
            {
                await this.BestEffortDelete(service, demoName)
            }
            this.StopForward()
            await this.BestEffortNamespaceDelete(namespace)
            await this.BestEffortNamespaceDelete(demoNamespace)
            await this.CleanupTempStores()
        }
        return !this.failed
    }

    /**
     * Demo phase: create a Template.DemoContoso env on the hive, then assert the seeded tree is live in the pod and that a
     * restart never re-seeds. Reads go through a kubectl port-forward tunnel because the cluster Service DNS is not
     * resolvable from the operator's machine.
     */
    private async RunDemoPhase(service: EnvironmentService, name: string, namespace: string): Promise<void>
    {
        const S = InClusterEnvCreateSmoke
        const record = await service.Create(name, Template.DemoContoso, EnvType.Runtime, undefined, S.HiveId)
        this.Expect(S.Labels.DemoCreate, record.hiveId === S.HiveId)
        const deployment = K8sManifestBuilder.ServerDeploymentOf(name)
        const dataDir = S.DataMount + S.PathSeparator + S.DemoEnvironmentId
        const markerPath = dataDir + S.PathSeparator + S.SeedMarkerName
        const probePath = dataDir + S.PathSeparator + S.LiveProbeName

        this.Expect(S.Labels.DemoMarker, await this.PodHasFile(namespace, deployment, markerPath))

        const port = await this.StartForward(namespace, deployment)
        const client = await this.ConnectAsAdmin(name, port)
        const apps = await client.ListApplications()
        this.Expect(S.Labels.DemoNorthwindRegistered, apps.some(a => a.name === NorthwindApp.AppName), apps.map(a => a.name).join(S.Comma))
        await client.OpenApplication(NorthwindApp.AppName)
        const orders = await client.CypherQuery(S.OrdersQuery)
        // The contoso seed tree carries NO northwind instances, so this asserts the read SUCCEEDS (and logs the row count);
        // requiring rows would fail on a correct system.
        this.Expect(S.Labels.DemoNorthwindQuery, Array.isArray(orders.items))
        console.log(S.InfoTag + S.OrdersInfo + String(orders.items.length))
        await this.CloseClients()
        this.StopForward()

        await this.PodExec(namespace, deployment, S.WriteProbeCommand + S.LiveProbeValue + S.RedirectOperator + probePath)
        this.Expect(S.Labels.DemoLiveWrite, await this.PodHasFile(namespace, deployment, probePath))

        const kubectl = new NodeExecFile()
        await kubectl.Run(S.Kubectl, [S.ContextFlag, S.Context, S.RolloutVerb, S.RestartVerb, S.DeploymentPrefix + deployment, S.NamespaceFlag, namespace])
        await kubectl.Run(S.Kubectl, [S.ContextFlag, S.Context, S.RolloutVerb, S.StatusVerb, S.DeploymentPrefix + deployment, S.NamespaceFlag, namespace])
        // A failed restart/rollout throws above; the marker and probe checks below are the real post-restart assertions.
        this.Expect(S.Labels.DemoNoReseedMarker, await this.PodHasFile(namespace, deployment, markerPath))
        this.Expect(S.Labels.DemoNoReseedLive, await this.PodHasFile(namespace, deployment, probePath))

        await this.RunStopStartPhase(service, name, namespace, deployment, probePath)

        await service.Delete(name)
        this.Expect(S.Labels.DemoDelete, true)
    }

    /**
     * Stop = scale-to-zero (OPERATOR-RUN, needs a live cluster): the pod disappears but the namespace, data PVC and env
     * Secrets are retained; Start brings the pod back healthy with the pre-Stop live-data probe still on the PVC.
     */
    private async RunStopStartPhase(service: EnvironmentService, name: string, namespace: string, deployment: string, probePath: string): Promise<void>
    {
        const S = InClusterEnvCreateSmoke
        await service.Stop(name)
        this.Expect(S.Labels.StopScaled, await this.WaitReadyReplicas(namespace, deployment, S.ZeroReplicas))
        const pvcs = await this.KubectlOut([S.GetVerb, S.PvcKind, S.NameOutput, S.NamespaceFlag, namespace])
        const secrets = await this.KubectlOut([S.GetVerb, S.SecretKind, S.NameOutput, S.NamespaceFlag, namespace])
        this.Expect(S.Labels.StopRetained, (await this.GetNamespace(namespace)) !== undefined && pvcs.trim().length > 0 && secrets.trim().length > 0)

        await service.Start(name)
        this.Expect(S.Labels.StartBack, await this.WaitReadyReplicas(namespace, deployment, S.OneReplica))
        const port = await this.StartForward(namespace, deployment)
        const health = await fetch(S.LoopbackHttp + String(port) + S.HealthzPath)
        this.StopForward()
        this.Expect(S.Labels.StartHealthy, health.ok)
        this.Expect(S.Labels.StartDataKept, await this.PodHasFile(namespace, deployment, probePath))
    }

    /** Polls the Deployment's readyReplicas (empty output means 0) until it equals the wanted count. */
    private async WaitReadyReplicas(namespace: string, deployment: string, wanted: number): Promise<boolean>
    {
        const S = InClusterEnvCreateSmoke
        for (let attempt = 0; attempt < S.ReplicaAttempts; attempt++)
        {
            const out = await this.KubectlOut([S.GetVerb, S.DeploymentKind, deployment, S.ReadyReplicasPath, S.NamespaceFlag, namespace])
            if (Number(out.trim() || S.ZeroReplicas) === wanted)
            {
                return true
            }
            await new Promise<void>(resolve => setTimeout(resolve, S.ReplicaIntervalMs))
        }
        return false
    }

    private async KubectlOut(args: string[]): Promise<string>
    {
        const S = InClusterEnvCreateSmoke
        const out = await new NodeExecFile().Run(S.Kubectl, [S.ContextFlag, S.Context, ...args])
        return out.stdout
    }

    /** Reads the env admin password from the per-env bundle the control plane generated, logs in over the tunnel and binds a client. */
    private async ConnectAsAdmin(name: string, port: number): Promise<PragmaticClient>
    {
        const S = InClusterEnvCreateSmoke
        const secretsPath = join(this.tempDir as string, name, S.SecretsFileName)
        const secrets = JSON.parse(await readFile(secretsPath, S.Utf8)) as Record<string, string>
        const ref = S.DemoEnvironmentId + BundleBuilder.AdminSecretSuffix
        const password = secrets[ref]
        if (password === undefined)
        {
            throw new Error(S.NoSecretMessage + ref)
        }
        const email = BundleBuilder.AdminEmailPrefix + S.DemoEnvironmentId + BundleBuilder.AdminEmailSuffix
        const token = await new UserSeeder().Login(S.LoopbackHttp + String(port), S.DemoEnvironmentId, email, password)
        const client = await PragmaticClient.ConnectAsync(S.LoopbackWs + String(port) + S.WsQuerySeparator + encodeURIComponent(S.DemoEnvironmentId), { bearerToken: token })
        this.clients.push(client)
        return client
    }

    private async CloseClients(): Promise<void>
    {
        for (const client of this.clients.splice(0))
        {
            await client.DisposeAsync()
        }
    }

    /** Spawns `kubectl port-forward deployment/<d> <local>:8080` and resolves the local port once kubectl reports it is forwarding. */
    private StartForward(namespace: string, deployment: string): Promise<number>
    {
        const S = InClusterEnvCreateSmoke
        const local = S.LocalPortBase + Math.floor(Math.random() * S.LocalPortSpread)
        const child = spawn(S.Kubectl, [S.ContextFlag, S.Context, S.PortForwardVerb, S.DeploymentPrefix + deployment, String(local) + S.PortMapSeparator + String(S.ServerPort), S.NamespaceFlag, namespace])
        this.forward = child
        return new Promise<number>((resolve, reject) =>
        {
            const timer = setTimeout(() =>
            {
                child.kill(S.SigTerm)
                reject(new Error(S.ForwardTimeoutMessage))
            }, S.ForwardTimeoutMs)
            child.stdout?.setEncoding(S.Utf8Encoding)
            child.stdout?.on(S.DataEvent, (chunk: string) =>
            {
                if (chunk.includes(S.ForwardingBanner))
                {
                    clearTimeout(timer)
                    resolve(local)
                }
            })
            child.on(S.ErrorEvent, (e: Error) =>
            {
                clearTimeout(timer)
                reject(e)
            })
        })
    }

    private StopForward(): void
    {
        this.forward?.kill(InClusterEnvCreateSmoke.SigTerm)
        this.forward = undefined
    }

    private async PodExec(namespace: string, deployment: string, script: string): Promise<string>
    {
        const S = InClusterEnvCreateSmoke
        const out = await new NodeExecFile().Run(S.Kubectl, [S.ContextFlag, S.Context, S.ExecVerb, S.DeploymentPrefix + deployment, S.NamespaceFlag, namespace, S.ContainerFlag, K8sManifestBuilder.ServerContainerName, S.ArgSeparator, S.ShellBinary, S.ShellEvalFlag, script])
        return out.stdout
    }

    private async PodHasFile(namespace: string, deployment: string, path: string): Promise<boolean>
    {
        try
        {
            await this.PodExec(namespace, deployment, InClusterEnvCreateSmoke.TestFileCommand + path)
            return true
        }
        catch
        {
            return false
        }
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
        const placement = new EnvironmentPlacement(directory)
        return new EnvironmentService(
            registry,
            new PortAllocator(S.EnvPortFloor, new NetPortProbe()),
            new EnvironmentRuntimeResolver(new DockerEnvironmentRuntime(docker, new BundleBuilderAdapter()), new InClusterEnvironmentRuntime(orchestrators, placement, directory, new BundleBuilderAdapter()), directory, orchestrators),
            new UserSeederAdapter(new UserSeeder()),
            dataRoot,
            new AdminProxy(new WsAdminConnector()),
            directory,
            new UncontactedIdpService(),
            UncontactedIdpService.ClientFactory())
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

    private async BestEffortDelete(service: EnvironmentService, name: string = InClusterEnvCreateSmoke.EnvName): Promise<void>
    {
        const S = InClusterEnvCreateSmoke
        try
        {
            await service.Delete(name)
        }
        catch (e)
        {
            console.log(S.TeardownWarning + name + S.DetailSep + KubectlError.Redact(e instanceof Error ? e.message : String(e)))
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
