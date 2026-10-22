/**
 * GATED real-cluster smoke for the k8s Hive Orchestrator. NOT part of `tsx --test`.
 *
 * Requires Docker Desktop's built-in Kubernetes (context `docker-desktop`) and the
 * `pragmatic-server:dev` image in the local docker image store (shared with the cluster;
 * the manifest uses imagePullPolicy IfNotPresent). Run with:
 *
 *   npx tsx admin/control-plane/k8s-hive-smoke.ts
 *
 * Drives a throwaway dev-blank environment through Apply -> WaitHealthy -> serve ->
 * Roll -> Teardown via the real HiveOrchestratorFactory / KubectlHiveOrchestrator.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { get } from 'node:http'
import { fileURLToPath } from 'node:url'
import { EnvironmentWorkloadFactory } from './environment-workload.js'
import type { EnvironmentWorkload } from './environment-workload.js'
import { EnvStatus, EnvType, Template } from './environment-record.js'
import type { EnvironmentRecord } from './environment-record.js'
import { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import type { IHiveOrchestrator } from './hive-orchestrator.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { KubectlError, NodeExecFile } from './kubectl.js'
import { HiveBackend, InfraMode } from './platform-records.js'
import type { HiveRecord } from './platform-records.js'

export class K8sHiveSmoke
{
    private static readonly Context = 'docker-desktop'
    private static readonly EnvPrefix = 'k8s-smoke-'
    private static readonly SuffixBytes = 3
    private static readonly Hex = 'hex'
    /** Per-run name so a run never collides with (or tears down) a pre-existing namespace. */
    private static readonly EnvName = K8sHiveSmoke.EnvPrefix + randomBytes(K8sHiveSmoke.SuffixBytes).toString(K8sHiveSmoke.Hex)
    private static readonly HiveId = 'smoke-hive'
    private static readonly TenantId = 'smoke-tenant'
    private static readonly Image = 'pragmatic-server:dev'
    private static readonly HealthPath = '/healthz'
    private static readonly LoopbackHost = '127.0.0.1'
    private static readonly EpochIso = '1970-01-01T00:00:00.000Z'
    private static readonly EmptyString = ''
    private static readonly BootBaseDirKey = 'PRAGMATIC_BASE_DIR'
    private static readonly BootBaseDir = '/tmp/pragmatic-data'
    private static readonly BootTenantKey = 'PRAGMATIC_TENANT_ID'
    private static readonly BootMasterKeyEnvKey = 'PRAGMATIC_MASTER_KEY_B64_ENV'
    private static readonly BootMasterKeyVar = 'SMOKE_MASTER_KEY_B64'
    private static readonly MasterKeyBytes = 32
    private static readonly Base64 = 'base64'
    private static readonly Kubectl = 'kubectl'
    private static readonly ContextFlag = '--context'
    private static readonly NamespaceFlag = '-n'
    private static readonly PortForwardVerb = 'port-forward'
    private static readonly GetVerb = 'get'
    private static readonly NamespaceKind = 'namespace'
    private static readonly ServicePrefix = 'service/'
    /** Empty local port before the colon = kubectl picks a free one, so no fixed local port can collide. */
    private static readonly AutoLocalPort = ':'
    private static readonly ForwardingPattern = /127\.0\.0\.1:(\d+)/
    private static readonly NotFoundWord = 'NotFound'
    private static readonly StdoutEvent = 'data'
    private static readonly ErrorEvent = 'error'
    private static readonly ExitEvent = 'exit'
    private static readonly EndEvent = 'end'
    private static readonly Utf8 = 'utf8'
    private static readonly SigTerm = 'SIGTERM'
    private static readonly StatusOk = 200
    private static readonly ForwardTimeoutMs = 30000
    private static readonly ServeAttempts = 20
    private static readonly ServeIntervalMs = 1000
    private static readonly PassTag = 'PASS '
    private static readonly FailTag = 'FAIL '
    private static readonly DetailSep = ' -- '
    private static readonly TeardownWarning = 'WARN best-effort teardown failed for namespace '
    private static readonly OverallPass = 'OVERALL PASS'
    private static readonly OverallFail = 'OVERALL FAIL'
    private static readonly CrashPrefix = 'smoke crashed: '
    private static readonly ForwardTimeoutMessage = 'port-forward did not report a local port in time'
    private static readonly ForwardExitedMessage = 'port-forward exited before reporting a local port'
    private static readonly StatusWord = ' status='
    private static readonly Labels = {
        Apply: 'k8s: Apply succeeds (namespace + server Deployment + Service)',
        Namespace: 'k8s: namespace exists after Apply',
        Healthy: 'k8s: WaitHealthy (server rollout completes, pod Ready)',
        Health: 'k8s: Health reports ready on the requested image',
        Serves: 'k8s: server answers /healthz through port-forward',
        Roll: 'k8s: Roll to the same image completes its rollout',
        Rolled: 'k8s: still ready after Roll',
        Teardown: 'k8s: Teardown completes',
        Gone: 'k8s: namespace reports NotFound after Teardown',
    }

    private failed = false

    public static async Main(): Promise<void>
    {
        const smoke = new K8sHiveSmoke()
        const ok = await smoke.Run()
        console.log(ok ? K8sHiveSmoke.OverallPass : K8sHiveSmoke.OverallFail)
        process.exit(ok ? 0 : 1)
    }

    public async Run(): Promise<boolean>
    {
        const S = K8sHiveSmoke
        const workload = S.Workload()
        const orchestrator = new HiveOrchestratorFactory(S.Context).For(S.Hive())
        const namespace = K8sManifestBuilder.NamespaceOf(workload.environmentName)
        let tornDown = false
        try
        {
            await orchestrator.Apply(workload)
            this.Expect(S.Labels.Apply, true)
            this.Expect(S.Labels.Namespace, await this.NamespaceExists(namespace))
            await orchestrator.WaitHealthy(workload)
            this.Expect(S.Labels.Healthy, true)
            await this.CheckHealth(orchestrator, workload, S.Labels.Health)
            await this.CheckServes(workload)
            await orchestrator.Roll(workload, S.Image)
            this.Expect(S.Labels.Roll, true)
            await this.CheckHealth(orchestrator, workload, S.Labels.Rolled)
            await orchestrator.Teardown(workload)
            tornDown = true
            this.Expect(S.Labels.Teardown, true)
            this.Expect(S.Labels.Gone, !(await this.NamespaceExists(namespace)))
        }
        catch (err)
        {
            this.failed = true
            console.log(S.CrashPrefix + (err instanceof Error ? err.message : String(err)))
        }
        finally
        {
            if (!tornDown)
            {
                await this.BestEffortTeardown(orchestrator, workload)
            }
        }
        return !this.failed
    }

    /** A throwaway dev-blank environment, derived exactly as production derives it (no database for dev-blank). */
    private static Workload(): EnvironmentWorkload
    {
        const S = K8sHiveSmoke
        const record: EnvironmentRecord = {
            name: S.EnvName,
            type: EnvType.Development,
            template: Template.DevBlank,
            tenantId: S.EnvName,
            hiveId: S.HiveId,
            hostPort: 0,
            containerName: S.EnvName,
            volumeName: S.EnvName,
            bundleDir: S.EmptyString,
            createdAt: S.EpochIso,
            status: EnvStatus.Unknown,
        }
        const stock = EnvironmentWorkloadFactory.From(record, S.Hive())
        return { ...stock, env: { ...stock.env, ...S.BootEnv() } }
    }

    /**
     * LOCAL-SMOKE-ONLY boot config. The stock workload carries only PRAGMATIC_PORT, but the server
     * refuses to start without a base dir, a tenant source and a master key (the docker model mounts
     * these as files). Injecting real config/secrets into a k8s workload is SP-HIVE-3's job; here a
     * throwaway random master key is set as a plain env var in a throwaway namespace purely so the
     * orchestrator mechanics can be proven against a pod that actually reaches Ready. The key is
     * generated per run, never logged, and never written to disk.
     */
    private static BootEnv(): Record<string, string>
    {
        const S = K8sHiveSmoke
        return {
            [S.BootBaseDirKey]: S.BootBaseDir,
            [S.BootTenantKey]: S.EnvName,
            [S.BootMasterKeyEnvKey]: S.BootMasterKeyVar,
            [S.BootMasterKeyVar]: randomBytes(S.MasterKeyBytes).toString(S.Base64),
        }
    }

    /** A local/attach hive pointing at the docker-desktop context. */
    private static Hive(): HiveRecord
    {
        const S = K8sHiveSmoke
        return {
            id: S.HiveId,
            tenantId: S.TenantId,
            displayName: S.HiveId,
            cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach, configRef: S.Context },
            registry: { mode: InfraMode.Attach },
            createdAt: S.EpochIso,
        }
    }

    private async CheckHealth(orchestrator: IHiveOrchestrator, workload: EnvironmentWorkload, label: string): Promise<void>
    {
        const health = await orchestrator.Health(workload)
        this.Expect(label, health.ready && health.runningImage === K8sHiveSmoke.Image, health.detail)
    }

    /**
     * Reaches the Service with `kubectl port-forward` rather than a NodePort: a NodePort claims a
     * cluster-wide port that outlives the run and can collide with other environments, whereas a
     * port-forward is a client-side tunnel on an auto-chosen free local port that dies with this process.
     */
    private async CheckServes(workload: EnvironmentWorkload): Promise<void>
    {
        const S = K8sHiveSmoke
        const service = S.ServicePrefix + K8sManifestBuilder.ServerDeploymentOf(workload.environmentName)
        const forward = spawn(S.Kubectl, [
            S.ContextFlag, S.Context,
            S.NamespaceFlag, K8sManifestBuilder.NamespaceOf(workload.environmentName),
            S.PortForwardVerb, service, S.AutoLocalPort + String(workload.serverPort),
        ])
        try
        {
            const port = await S.LocalPortOf(forward)
            const status = await this.ProbeHealth(port)
            this.Expect(S.Labels.Serves, status === S.StatusOk, S.StatusWord + String(status))
        }
        finally
        {
            forward.kill(S.SigTerm)
        }
    }

    /** Resolves the local port from kubectl's "Forwarding from 127.0.0.1:PORT -> ..." line. */
    private static LocalPortOf(forward: ChildProcess): Promise<number>
    {
        const S = K8sHiveSmoke
        return new Promise<number>((resolve, reject) =>
        {
            const timer = setTimeout(() => reject(new Error(S.ForwardTimeoutMessage)), S.ForwardTimeoutMs)
            forward.stdout?.setEncoding(S.Utf8)
            forward.stdout?.on(S.StdoutEvent, (chunk: string) =>
            {
                const match = S.ForwardingPattern.exec(chunk)
                if (match !== null)
                {
                    clearTimeout(timer)
                    resolve(Number(match[1]))
                }
            })
            forward.on(S.ErrorEvent, err =>
            {
                clearTimeout(timer)
                reject(err)
            })
            forward.on(S.ExitEvent, () =>
            {
                clearTimeout(timer)
                reject(new Error(S.ForwardExitedMessage))
            })
        })
    }

    /** GETs /healthz, retrying briefly (the tunnel can lag the first request); returns the last status, 0 if never answered. */
    private async ProbeHealth(port: number): Promise<number>
    {
        const S = K8sHiveSmoke
        let status = 0
        for (let attempt = 0; attempt < S.ServeAttempts && status !== S.StatusOk; attempt++)
        {
            status = await S.HttpStatus(port)
            if (status !== S.StatusOk)
            {
                await new Promise<void>(resolve => setTimeout(resolve, S.ServeIntervalMs))
            }
        }
        return status
    }

    private static HttpStatus(port: number): Promise<number>
    {
        const S = K8sHiveSmoke
        return new Promise<number>(resolve =>
        {
            const req = get({ host: S.LoopbackHost, port, path: S.HealthPath }, res =>
            {
                res.resume()
                res.on(S.EndEvent, () => resolve(res.statusCode ?? 0))
            })
            req.on(S.ErrorEvent, () => resolve(0))
        })
    }

    /** `kubectl get namespace` succeeding = exists; a NotFound failure = gone; any other failure is a real error. */
    private async NamespaceExists(namespace: string): Promise<boolean>
    {
        const S = K8sHiveSmoke
        try
        {
            await new NodeExecFile().Run(S.Kubectl, [S.ContextFlag, S.Context, S.GetVerb, S.NamespaceKind, namespace])
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

    /** Failure-path cleanup so a crashed run never leaves the namespace behind. */
    private async BestEffortTeardown(orchestrator: IHiveOrchestrator, workload: EnvironmentWorkload): Promise<void>
    {
        const S = K8sHiveSmoke
        try
        {
            await orchestrator.Teardown(workload)
        }
        catch (e)
        {
            console.log(S.TeardownWarning + K8sManifestBuilder.NamespaceOf(workload.environmentName) + S.DetailSep + KubectlError.Redact(e instanceof Error ? e.message : String(e)))
        }
    }

    private Expect(label: string, ok: boolean, detail: string = K8sHiveSmoke.EmptyString): void
    {
        if (!ok)
        {
            this.failed = true
        }
        const suffix = ok || detail === K8sHiveSmoke.EmptyString ? K8sHiveSmoke.EmptyString : K8sHiveSmoke.DetailSep + detail
        console.log((ok ? K8sHiveSmoke.PassTag : K8sHiveSmoke.FailTag) + label + suffix)
    }

    /** True when this module is the process entry point (not when imported). */
    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
    }
}

if (K8sHiveSmoke.IsEntryPoint())
{
    await K8sHiveSmoke.Main()
}
