/**
 * GATED real-cluster smoke for the in-cluster per-tenant IdP apply. NOT part of `tsx --test`.
 *
 * Requires Docker Desktop's built-in Kubernetes (context `docker-desktop`) and the `pragmatic-server:dev` image
 * (which carries the `pragmatic-idpd` binary the IdP pod runs) in the local image store. Run with:
 *
 *   npx tsx admin/control-plane/in-cluster-idp-smoke.ts
 *
 * Drives a real InClusterIdpDriver (wired with the InClusterIdpSeedSource, real KubectlCli + K8sManifestBuilder) in-process:
 * EnsureRunning applies the seed Secrets + the IdP workload and waits for rollout. The host then port-forwards the IdP Service and,
 * over the seeded CA only (rejectUnauthorized, SNI = the Service-DNS host so the cert SAN matches), proves the admin API gates on the
 * seeded token, the realm serves OIDC discovery, and the jwks_uri returns keys. It also reads the applied per-tenant TLS Secret back and
 * asserts its data keys are exactly server.crt/server.key/ca.crt (the CA signing key ca.key is never shipped); the healthy pod above proves
 * DevCa.EnsureAt does not re-mint against that read-only mount. Operator-run only (needs a cluster). Finally re-applies (idempotency) and deletes the namespace.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { request } from 'node:https'
import { fileURLToPath } from 'node:url'
import { InClusterIdpDriver } from './in-cluster-idp-driver.js'
import { InClusterIdpSeedSource } from './in-cluster-idp-seed.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { KubectlCli, KubectlError, NodeExecFile } from './kubectl.js'
import { IdpStatus } from './idp-record.js'
import type { IdpWorkloadResult } from './idp-workload-driver.js'

interface HttpsResponse
{
    status: number
    body: string
}

export class InClusterIdpSmoke
{
    private static readonly Context = 'docker-desktop'
    private static readonly HiveId = 'icc-hive'
    private static readonly TenantId = 'icc-idp'
    private static readonly Image = 'pragmatic-server:dev'
    private static readonly Kubectl = 'kubectl'
    private static readonly ContextFlag = '--context'
    private static readonly NamespaceFlag = '-n'
    private static readonly OutputFlag = '-o'
    private static readonly PhaseJsonPath = 'jsonpath={.status.phase}'
    private static readonly TerminatingPhase = 'Terminating'
    private static readonly WideOutput = 'wide'
    private static readonly TailFlag = '--tail=60'
    private static readonly PortForwardVerb = 'port-forward'
    private static readonly GetVerb = 'get'
    private static readonly NamespaceKind = 'namespace'
    private static readonly LogsVerb = 'logs'
    private static readonly DescribeVerb = 'describe'
    private static readonly PodsKind = 'pods'
    private static readonly DeployPrefix = 'deployment/'
    private static readonly ServicePrefix = 'service/'
    private static readonly AutoLocalPort = ':'
    private static readonly ServicePort = 9443
    private static readonly ForwardingPattern = /127\.0\.0\.1:(\d+)/
    private static readonly NotFoundWord = 'NotFound'
    private static readonly DataEvent = 'data'
    private static readonly ErrorEvent = 'error'
    private static readonly ExitEvent = 'exit'
    private static readonly EndEvent = 'end'
    private static readonly TimeoutEvent = 'timeout'
    private static readonly Utf8 = 'utf8'
    private static readonly SecretKind = 'secret'
    private static readonly DataJsonPath = 'jsonpath={.data}'
    private static readonly ExpectedTlsKeys = ['ca.crt', 'server.crt', 'server.key']
    private static readonly CaKeyName = 'ca.key'
    private static readonly SigTerm = 'SIGTERM'
    private static readonly LoopbackHost = '127.0.0.1'
    private static readonly ForwardTimeoutMs = 30000
    private static readonly RequestTimeoutMs = 10000
    private static readonly Attempts = 20
    private static readonly TerminatingAttempts = 60
    private static readonly IntervalMs = 1000
    private static readonly StatusOk = 200
    private static readonly OkMax = 300
    private static readonly Unauthorized = [401, 403]
    private static readonly PassTag = 'PASS '
    private static readonly FailTag = 'FAIL '
    private static readonly DetailSep = ' -- '
    private static readonly OverallPass = 'OVERALL PASS'
    private static readonly OverallFail = 'OVERALL FAIL'
    private static readonly CrashPrefix = 'smoke crashed: '
    private static readonly DiagHeader = 'DIAG '
    private static readonly TeardownWarning = 'WARN teardown failed -- '
    private static readonly ForwardTimeoutMessage = 'port-forward did not report a local port in time'
    private static readonly ForwardExitedMessage = 'port-forward exited before reporting a local port'
    private static readonly EmptyString = ''
    private static readonly Space = ' '
    private static readonly Slash = '/'
    private static readonly Comma = ','
    private static readonly KeysTag = 'keys='
    private static readonly MissingTag = ' missing='
    private static readonly StatusTag = 'status='
    private static readonly NoJwksUri = 'no jwks_uri'
    private static readonly MethodGet = 'GET'
    private static readonly MethodPut = 'PUT'
    private static readonly Bearer = 'Bearer '
    private static readonly AuthHeader = 'Authorization'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly ContentLengthHeader = 'Content-Length'
    private static readonly HostHeader = 'Host'
    private static readonly JsonType = 'application/json'
    private static readonly BadToken = 'definitely-not-the-token'
    private static readonly AdminRealmPrefix = '/_admin/realms/'
    private static readonly RealmBody = '{"displayName":"ICC smoke"}'
    private static readonly DiscoveryPath = '.well-known/openid-configuration'
    private static readonly JwksUriField = 'jwks_uri'
    private static readonly Fields = ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri']
    private static readonly JwksKeysField = 'keys'
    private static readonly Labels = {
        Ready: 'idp: EnsureRunning applies seed Secrets + workload and rollout reaches Ready',
        TlsSecret: 'idp: applied TLS Secret carries exactly server.crt/server.key/ca.crt and no ca.key',
        Connection: 'idp: connection reports Service-DNS baseUrl + seeded CA + admin token',
        AdminBad: 'idp: admin API rejects a bad token',
        AdminOk: 'idp: admin API accepts the seeded token (EnsureRealm)',
        Discovery: 'idp: OIDC discovery over the seeded CA exposes issuer/authorization/token/jwks_uri',
        Jwks: 'idp: jwks_uri returns at least one key',
        Idempotent: 'idp: second EnsureRunning is idempotent',
        Teardown: 'idp: namespace delete removes the IdP namespace (gone or Terminating)',
    }

    private failed = false

    public static async Main(): Promise<void>
    {
        const ok = await new InClusterIdpSmoke().Run()
        console.log(ok ? InClusterIdpSmoke.OverallPass : InClusterIdpSmoke.OverallFail)
        process.exit(ok ? 0 : 1)
    }

    public async Run(): Promise<boolean>
    {
        const S = InClusterIdpSmoke
        const namespace = K8sManifestBuilder.IdpNameOf(S.TenantId)
        const kubectl = new KubectlCli(S.Context)
        const driver = new InClusterIdpDriver(kubectl, new K8sManifestBuilder(), new InClusterIdpSeedSource(), S.HiveId, S.Image)
        let forward: ChildProcess | undefined
        try
        {
            await kubectl.DeleteNamespace(namespace)
            await this.WaitGone(namespace)
            const result = await driver.EnsureRunning({ tenantId: S.TenantId, displayName: S.TenantId, takenPorts: [] })
            this.Expect(S.Labels.Ready, result.record.status === IdpStatus.Running && result.record.baseUrl === result.connection.baseUrl, S.RecordDetail(result))
            this.Expect(S.Labels.Connection, S.ConnectionOk(result))
            forward = this.StartForward(namespace)
            const port = await S.LocalPortOf(forward)
            const host = new URL(result.connection.baseUrl).hostname
            const ca = result.connection.ca
            const realmPath = S.AdminRealmPrefix + encodeURIComponent(S.TenantId)
            const bad = await this.Retry(() => S.Https(port, host, ca, S.MethodPut, realmPath, S.BadToken, S.RealmBody), r => r.status !== 0)
            this.Expect(S.Labels.AdminBad, S.Unauthorized.includes(bad.status), S.StatusDetail(bad))
            const good = await S.Https(port, host, ca, S.MethodPut, realmPath, result.connection.adminToken, S.RealmBody)
            this.Expect(S.Labels.AdminOk, good.status >= S.StatusOk && good.status < S.OkMax, S.StatusDetail(good))
            const discovery = await S.Https(port, host, ca, S.MethodGet, S.Slash + S.TenantId + S.Slash + S.DiscoveryPath)
            const doc = S.ParseObject(discovery.body)
            const missing = S.Fields.filter(f => typeof doc?.[f] !== 'string')
            this.Expect(S.Labels.Discovery, discovery.status === S.StatusOk && doc !== undefined && missing.length === 0, S.StatusDetail(discovery) + S.MissingTag + missing.join(S.Comma))
            const uri = doc?.[S.JwksUriField]
            const jwks = typeof uri === 'string' ? await S.Https(port, host, ca, S.MethodGet, new URL(uri).pathname) : undefined
            const keys = S.ParseObject(jwks?.body ?? S.EmptyString)?.[S.JwksKeysField]
            this.Expect(S.Labels.Jwks, Array.isArray(keys) && keys.length > 0, jwks === undefined ? S.NoJwksUri : S.StatusDetail(jwks))
            const again = await driver.EnsureRunning({ tenantId: S.TenantId, displayName: S.TenantId, takenPorts: [], existing: result.record })
            this.Expect(S.Labels.Idempotent, again.record === result.record && again.record.status === IdpStatus.Running && again.connection.baseUrl === result.connection.baseUrl && again.connection.ca.equals(result.connection.ca), S.RecordDetail(again))
        }
        catch (err)
        {
            this.failed = true
            console.log(S.CrashPrefix + KubectlError.Redact(err instanceof Error ? err.message : String(err)))
            await this.Diagnose(namespace)
        }
        finally
        {
            forward?.kill(S.SigTerm)
            try
            {
                await kubectl.DeleteNamespace(namespace)
                this.Expect(S.Labels.Teardown, await this.WaitGone(namespace))
            }
            catch (e)
            {
                this.failed = true
                console.log(S.TeardownWarning + KubectlError.Redact(e instanceof Error ? e.message : String(e)))
            }
        }
        return !this.failed
    }

    private static RecordDetail(result: IdpWorkloadResult): string
    {
        return InClusterIdpSmoke.StatusTag + String(result.record.status)
    }

    private static ConnectionOk(result: IdpWorkloadResult): boolean
    {
        const c = result.connection
        return c.baseUrl === K8sManifestBuilder.IdpBaseUrlOf(InClusterIdpSmoke.TenantId, InClusterIdpSmoke.ServicePort) && c.ca.length > 0 && c.adminToken.length > 0
    }

    /** Reads the applied per-tenant TLS Secret back from the cluster and checks its key set (names only; values are never printed). */
    private async CheckTlsSecret(namespace: string): Promise<void>
    {
        const S = InClusterIdpSmoke
        const name = InClusterIdpSeedSource.TlsSecretNameOf(S.TenantId)
        const out = await new NodeExecFile().Run(S.Kubectl, [S.ContextFlag, S.Context, S.NamespaceFlag, namespace, S.GetVerb, S.SecretKind, name, S.OutputFlag, S.DataJsonPath])
        const keys = Object.keys(S.ParseObject(out.stdout) ?? {}).sort()
        this.Expect(S.Labels.TlsSecret, keys.join(S.Comma) === S.ExpectedTlsKeys.join(S.Comma) && !keys.includes(S.CaKeyName), S.KeysTag + keys.join(S.Comma))
    }

    private StartForward(namespace: string): ChildProcess
    {
        const S = InClusterIdpSmoke
        return spawn(S.Kubectl, [S.ContextFlag, S.Context, S.NamespaceFlag, namespace, S.PortForwardVerb, S.ServicePrefix + namespace, S.AutoLocalPort + String(S.ServicePort)])
    }

    private static LocalPortOf(forward: ChildProcess): Promise<number>
    {
        const S = InClusterIdpSmoke
        return new Promise<number>((resolve, reject) =>
        {
            const timer = setTimeout(() => reject(new Error(S.ForwardTimeoutMessage)), S.ForwardTimeoutMs)
            forward.stdout?.setEncoding(S.Utf8)
            forward.stdout?.on(S.DataEvent, (chunk: string) =>
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

    /** One HTTPS request through the tunnel: TCP to loopback, TLS verified against the seeded CA with SNI/Host = the Service-DNS host. status 0 = transport failure. */
    private static Https(port: number, host: string, ca: Buffer, method: string, path: string, token?: string, body?: string): Promise<HttpsResponse>
    {
        const S = InClusterIdpSmoke
        return new Promise<HttpsResponse>(resolve =>
        {
            const headers: Record<string, string> = { [S.HostHeader]: host + ':' + String(S.ServicePort) }
            if (token !== undefined)
            {
                headers[S.AuthHeader] = S.Bearer + token
            }
            if (body !== undefined)
            {
                headers[S.ContentTypeHeader] = S.JsonType
                headers[S.ContentLengthHeader] = String(Buffer.byteLength(body))
            }
            const req = request({ host: S.LoopbackHost, port, servername: host, method, path, ca, rejectUnauthorized: true, headers, timeout: S.RequestTimeoutMs }, res =>
            {
                const chunks: Buffer[] = []
                res.on(S.DataEvent, (c: Buffer) => chunks.push(c))
                res.on(S.EndEvent, () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(S.Utf8) }))
            })
            req.on(S.TimeoutEvent, () => req.destroy())
            req.on(S.ErrorEvent, err => resolve({ status: 0, body: err.message }))
            req.end(body)
        })
    }

    private async Retry(fn: () => Promise<HttpsResponse>, done: (r: HttpsResponse) => boolean): Promise<HttpsResponse>
    {
        const S = InClusterIdpSmoke
        let last = await fn()
        for (let i = 1; i < S.Attempts && !done(last); i++)
        {
            await new Promise<void>(r => setTimeout(r, S.IntervalMs))
            last = await fn()
        }
        return last
    }

    private static ParseObject(text: string): Record<string, unknown> | undefined
    {
        try
        {
            const parsed: unknown = JSON.parse(text)
            return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
        }
        catch
        {
            return undefined
        }
    }

    private static StatusDetail(r: HttpsResponse): string
    {
        const S = InClusterIdpSmoke
        return S.StatusTag + String(r.status) + (r.status === 0 ? S.Space + r.body : S.EmptyString)
    }

    private async NamespaceExists(namespace: string): Promise<boolean>
    {
        const S = InClusterIdpSmoke
        try
        {
            await new NodeExecFile().Run(S.Kubectl, [S.ContextFlag, S.Context, S.GetVerb, S.NamespaceKind, namespace])
            return true
        }
        catch (e)
        {
            if (String((e as { stderr?: unknown }).stderr ?? S.EmptyString).includes(S.NotFoundWord))
            {
                return false
            }
            throw e
        }
    }

    /** True once the namespace is gone, or (after the poll window) still present but Terminating -- deletion in flight counts as removed. */
    private async WaitGone(namespace: string): Promise<boolean>
    {
        const S = InClusterIdpSmoke
        for (let i = 0; i < S.TerminatingAttempts; i++)
        {
            if (!(await this.NamespaceExists(namespace)))
            {
                return true
            }
            await new Promise<void>(r => setTimeout(r, S.IntervalMs))
        }
        try
        {
            const out = await new NodeExecFile().Run(S.Kubectl, [S.ContextFlag, S.Context, S.GetVerb, S.NamespaceKind, namespace, S.OutputFlag, S.PhaseJsonPath])
            return out.stdout.trim() === S.TerminatingPhase
        }
        catch (e)
        {
            // Vanished between the last poll and this read: that is gone.
            if (String((e as { stderr?: unknown }).stderr ?? S.EmptyString).includes(S.NotFoundWord))
            {
                return true
            }
            throw e
        }
    }

    /** On failure, dumps pod listing + description + logs (redacted) so an environmental blocker is recorded exactly. */
    private async Diagnose(namespace: string): Promise<void>
    {
        const S = InClusterIdpSmoke
        const exec = new NodeExecFile()
        const commands = [[S.GetVerb, S.PodsKind, S.OutputFlag, S.WideOutput], [S.DescribeVerb, S.PodsKind], [S.LogsVerb, S.DeployPrefix + namespace, S.TailFlag]]
        for (const args of commands)
        {
            try
            {
                const out = await exec.Run(S.Kubectl, [S.ContextFlag, S.Context, S.NamespaceFlag, namespace, ...args])
                console.log(S.DiagHeader + args.join(S.Space) + '\n' + KubectlError.Redact(out.stdout))
            }
            catch (e)
            {
                console.log(S.DiagHeader + args.join(S.Space) + S.DetailSep + KubectlError.Redact(e instanceof Error ? e.message : String(e)))
            }
        }
    }

    private Expect(label: string, ok: boolean, detail: string = InClusterIdpSmoke.EmptyString): void
    {
        if (!ok)
        {
            this.failed = true
        }
        const suffix = detail === InClusterIdpSmoke.EmptyString ? InClusterIdpSmoke.EmptyString : InClusterIdpSmoke.DetailSep + detail
        console.log((ok ? InClusterIdpSmoke.PassTag : InClusterIdpSmoke.FailTag) + label + suffix)
    }

    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
    }
}

if (InClusterIdpSmoke.IsEntryPoint())
{
    await InClusterIdpSmoke.Main()
}
