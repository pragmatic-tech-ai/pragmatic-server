/**
 * GATED real-cluster smoke for the in-cluster OCI registry (SP-HIVE UI-serving, Spec 1). OPERATOR-RUN ONLY: NOT a *.test.ts,
 * NOT part of `tsx --test` / `npm test`, never executed by CI.
 *
 * Requires on PATH: `docker`, `kind`, `kubectl`, a running Docker daemon, host port 30500 free, and network access to pull
 * `registry:2` and `curlimages/curl`. Run with:
 *
 *   npx tsx admin/control-plane/registry-roundtrip-smoke.ts
 *
 * Steps: (1) create a kind cluster with a :30500 extraPortMapping and load registry:2; (2) apply the rendered registry manifest
 * and wait for the Deployment; (3) from the host, GET /v2/ and push + pull a blob through the node port; (4) from a throwaway
 * in-cluster pod, GET /v2/ through the Service DNS name; (5) tear the cluster down.
 */
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { InClusterRegistry } from './in-cluster-registry.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { KindCli } from './kind.js'
import { KubectlCli, KubectlError, NodeExecFile } from './kubectl.js'

export class RegistryRoundtripSmoke
{
    private static readonly ClusterName = 'registry-smoke'
    private static readonly Context = 'kind-registry-smoke'
    private static readonly HiveId = 'registry-smoke-hive'
    private static readonly Scheme = 'http://'
    private static readonly Repo = 'smoke/blob'
    private static readonly Tag = 'latest'
    private static readonly BlobBytes = 64
    private static readonly HashAlgorithm = 'sha256'
    private static readonly DigestPrefix = 'sha256:'
    private static readonly Hex = 'hex'
    private static readonly OkStatus = 200
    private static readonly CreatedStatus = 201
    private static readonly AcceptedStatus = 202
    private static readonly UploadsPath = '/blobs/uploads/'
    private static readonly BlobsPath = '/blobs/'
    private static readonly ManifestsPath = '/manifests/'
    private static readonly LocationHeader = 'location'
    private static readonly DigestQuery = 'digest'
    private static readonly OctetStream = 'application/octet-stream'
    private static readonly ContentType = 'content-type'
    private static readonly ManifestMediaType = 'application/vnd.oci.image.manifest.v1+json'
    private static readonly EmptyConfigMediaType = 'application/vnd.oci.empty.v1+json'
    private static readonly EmptyConfigJson = '{}'
    private static readonly SchemaVersion = 2
    private static readonly PostMethod = 'POST'
    private static readonly PutMethod = 'PUT'
    private static readonly Docker = 'docker'
    private static readonly PullVerb = 'pull'
    private static readonly Kubectl = 'kubectl'
    private static readonly ContextFlag = '--context'
    private static readonly NamespaceFlag = '-n'
    private static readonly RunVerb = 'run'
    private static readonly PodName = 'registry-smoke-curl'
    private static readonly CurlImage = 'curlimages/curl'
    private static readonly CurlBinary = 'curl'
    private static readonly RemoveFlag = '--rm'
    private static readonly AttachFlag = '-i'
    private static readonly RestartFlag = '--restart=Never'
    private static readonly ImageFlag = '--image='
    private static readonly CommandSeparator = '--'
    private static readonly CurlFailFlags: readonly string[] = ['-sSf', '--max-time', '30']
    private static readonly RetryAttempts = 30
    private static readonly RetryIntervalMs = 2000

    private static readonly PassTag = 'PASS '
    private static readonly FailTag = 'FAIL '
    private static readonly DetailSep = ' -- '
    private static readonly CrashPrefix = 'smoke crashed: '
    private static readonly TeardownWarn = 'WARN best-effort teardown failed for '
    private static readonly OverallPass = 'OVERALL PASS'
    private static readonly OverallFail = 'OVERALL FAIL'
    private static readonly Labels = {
        Cluster: 'kind cluster created with the :30500 mapping and registry:2 loaded',
        Rollout: 'registry manifest applied and the Deployment rolled out',
        HostV2: 'host: GET /v2/ through the node port returns 200',
        BlobPush: 'host: monolithic blob upload accepted',
        BlobRoundtrip: 'host: blob GET by digest is byte-equal to what was pushed',
        ManifestPush: 'host: minimal manifest PUT accepted',
        PodDns: 'pod: GET /v2/ through the Service DNS name exits 0',
    }

    private failed = false
    private readonly exec = new NodeExecFile()
    private readonly kind = new KindCli(this.exec)
    private readonly kubectl = new KubectlCli(RegistryRoundtripSmoke.Context, this.exec)

    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
    }

    public static async Main(): Promise<void>
    {
        const ok = await new RegistryRoundtripSmoke().Run()
        console.log(ok ? RegistryRoundtripSmoke.OverallPass : RegistryRoundtripSmoke.OverallFail)
        process.exitCode = ok ? 0 : 1
    }

    public async Run(): Promise<boolean>
    {
        const S = RegistryRoundtripSmoke
        try
        {
            await this.exec.Run(S.Docker, [S.PullVerb, InClusterRegistry.Image])
            await this.kind.CreateCluster(S.ClusterName, { extraPortMappings: [InClusterRegistry.NodePort] })
            await this.kind.LoadImage(InClusterRegistry.Image, S.ClusterName)
            this.Expect(S.Labels.Cluster, true)

            await this.kubectl.Apply(new K8sManifestBuilder().RenderRegistry(S.HiveId))
            await this.kubectl.RolloutStatus(InClusterRegistry.Namespace, InClusterRegistry.RegistryName)
            this.Expect(S.Labels.Rollout, true)

            await this.HostRoundtrip()
            await this.PodReachability()
        }
        catch (err)
        {
            this.failed = true
            console.log(S.CrashPrefix + KubectlError.Redact(err instanceof Error ? err.message : String(err)))
        }
        finally
        {
            try
            {
                await this.kind.DeleteCluster(S.ClusterName)
            }
            catch (err)
            {
                console.log(S.TeardownWarn + S.ClusterName + S.DetailSep + KubectlError.Redact(err instanceof Error ? err.message : String(err)))
            }
        }
        return !this.failed
    }

    private static BaseUrl(): string
    {
        return RegistryRoundtripSmoke.Scheme + InClusterRegistry.PushBase()
    }

    /** GET /v2/, then push a blob monolithically, read it back by digest, and PUT a minimal manifest referencing it. */
    private async HostRoundtrip(): Promise<void>
    {
        const S = RegistryRoundtripSmoke
        const v2 = await this.Retry(async () => fetch(S.BaseUrl() + InClusterRegistry.V2Path))
        this.Expect(S.Labels.HostV2, v2.status === S.OkStatus, String(v2.status))

        const repoUrl = S.BaseUrl() + InClusterRegistry.V2Path + S.Repo
        const bytes = randomBytes(S.BlobBytes)
        const digest = S.DigestPrefix + createHash(S.HashAlgorithm).update(bytes).digest(S.Hex)

        const start = await fetch(repoUrl + S.UploadsPath, { method: S.PostMethod })
        const location = start.headers.get(S.LocationHeader)
        if (start.status !== S.AcceptedStatus || location === null)
        {
            this.Expect(S.Labels.BlobPush, false, String(start.status))
            return
        }
        const target = new URL(location, S.BaseUrl())
        target.searchParams.set(S.DigestQuery, digest)
        const put = await fetch(target, { method: S.PutMethod, headers: { [S.ContentType]: S.OctetStream }, body: bytes })
        this.Expect(S.Labels.BlobPush, put.status === S.CreatedStatus, String(put.status))

        const back = await fetch(repoUrl + S.BlobsPath + digest)
        const received = Buffer.from(await back.arrayBuffer())
        this.Expect(S.Labels.BlobRoundtrip, back.status === S.OkStatus && received.equals(bytes), String(back.status))

        await this.PushManifest(repoUrl, digest, bytes.length)
    }

    /** Uploads the empty config blob and a minimal OCI manifest whose single layer is the pushed blob. */
    private async PushManifest(repoUrl: string, layerDigest: string, layerSize: number): Promise<void>
    {
        const S = RegistryRoundtripSmoke
        const config = Buffer.from(S.EmptyConfigJson)
        const configDigest = S.DigestPrefix + createHash(S.HashAlgorithm).update(config).digest(S.Hex)
        const start = await fetch(repoUrl + S.UploadsPath, { method: S.PostMethod })
        const location = start.headers.get(S.LocationHeader)
        if (location === null)
        {
            this.Expect(S.Labels.ManifestPush, false, String(start.status))
            return
        }
        const target = new URL(location, S.BaseUrl())
        target.searchParams.set(S.DigestQuery, configDigest)
        await fetch(target, { method: S.PutMethod, headers: { [S.ContentType]: S.OctetStream }, body: config })
        const manifest = JSON.stringify({
            schemaVersion: S.SchemaVersion,
            mediaType: S.ManifestMediaType,
            config: { mediaType: S.EmptyConfigMediaType, digest: configDigest, size: config.length },
            layers: [{ mediaType: S.OctetStream, digest: layerDigest, size: layerSize }],
        })
        const put = await fetch(repoUrl + S.ManifestsPath + S.Tag, { method: S.PutMethod, headers: { [S.ContentType]: S.ManifestMediaType }, body: manifest })
        this.Expect(S.Labels.ManifestPush, put.status === S.CreatedStatus, String(put.status))
    }

    /** A throwaway curl pod in the cluster must reach the registry through its Service DNS name. */
    private async PodReachability(): Promise<void>
    {
        const S = RegistryRoundtripSmoke
        const url = S.Scheme + InClusterRegistry.PullBase() + InClusterRegistry.V2Path
        const args = [
            S.ContextFlag, S.Context, S.NamespaceFlag, InClusterRegistry.Namespace,
            S.RunVerb, S.PodName, S.RemoveFlag, S.AttachFlag, S.RestartFlag, S.ImageFlag + S.CurlImage,
            S.CommandSeparator, S.CurlBinary, ...S.CurlFailFlags, url,
        ]
        let ok = true
        let detail = ''
        try
        {
            await this.exec.Run(S.Kubectl, args)
        }
        catch (err)
        {
            ok = false
            detail = KubectlError.Redact(err instanceof Error ? err.message : String(err))
        }
        this.Expect(S.Labels.PodDns, ok, detail)
    }

    private async Retry<T>(action: () => Promise<T>): Promise<T>
    {
        const S = RegistryRoundtripSmoke
        let last: unknown
        for (let attempt = 0; attempt < S.RetryAttempts; attempt++)
        {
            try
            {
                return await action()
            }
            catch (err)
            {
                last = err
                await new Promise<void>(resolve => setTimeout(resolve, S.RetryIntervalMs))
            }
        }
        throw last
    }

    private Expect(label: string, ok: boolean, detail: string = ''): void
    {
        const S = RegistryRoundtripSmoke
        if (!ok)
        {
            this.failed = true
        }
        console.log((ok ? S.PassTag : S.FailTag) + label + (detail !== '' && !ok ? S.DetailSep + detail : ''))
    }
}

if (RegistryRoundtripSmoke.IsEntryPoint())
{
    await RegistryRoundtripSmoke.Main()
}
