import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BundleBuilder } from '../../environments/seed/bundle.js'
import type { ClusterTunnelPool } from './cluster-tunnel-pool.js'
import { EnvServerSeedSource } from './env-server-seed.js'
import type { EnvironmentRecord } from './environment-record.js'
import { EnvironmentWorkloadFactory } from './environment-workload.js'
import type { HiveOrchestratorFactory } from './hive-orchestrator-factory.js'
import { UnsupportedBackendError } from './hive-orchestrator.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { KubectlCli, type IKubectl, type IPortForwardingKubectl, type IProcessSpawner } from './kubectl.js'
import type { HiveRecord } from './platform-records.js'
import type { ITenantDirectory } from './tenant-api/tenant-directory.js'

/** Where the platform (this host) reaches an environment server over HTTP and WebSocket. */
export type EnvironmentUrls = { httpUrl: string; wsUrl: string }

/** Environment URLs held open until Release (idempotent): an in-cluster tunnel stays up while any lease is held. */
export type EnvironmentUrlsLease = EnvironmentUrls & { Release(): void }

/** The environment runs on a hive the platform cannot reach (unknown hive, unsupported backend, no kubectl context). */
export class EnvironmentUnreachableError extends Error
{
    public static readonly DefaultMessage = 'The environment\'s hive is not reachable from the platform.'
    private static readonly ErrorName = 'EnvironmentUnreachableError'

    public constructor()
    {
        super(EnvironmentUnreachableError.DefaultMessage)
        this.name = EnvironmentUnreachableError.ErrorName
    }
}

/** The environment's provisioned secrets could not be read as a secrets map. Carries a fixed message, never content. */
export class EnvironmentSecretsUnreadableError extends Error
{
    public static readonly DefaultMessage = 'The environment\'s provisioned secrets could not be read.'
    private static readonly ErrorName = 'EnvironmentSecretsUnreadableError'

    public constructor()
    {
        super(EnvironmentSecretsUnreadableError.DefaultMessage)
        this.name = EnvironmentSecretsUnreadableError.ErrorName
    }
}

/**
 * Resolves how the platform reaches an environment and its Owner password. A Docker record (hostPort set) is on this
 * host: `localhost:<hostPort>` and its local bundle. An in-cluster record is reached through a pooled kubectl
 * port-forward to its server Service, and its password is read from the env Secret in the cluster.
 */
export class EnvironmentEndpoints
{
    private static readonly LocalHttpPrefix = 'http://localhost:'
    private static readonly LocalWsPrefix = 'ws://localhost:'
    private static readonly TunnelHttpPrefix = 'http://127.0.0.1:'
    private static readonly TunnelWsPrefix = 'ws://127.0.0.1:'
    private static readonly ServicePrefix = 'svc/'
    private static readonly SecretPrefix = 'secret/'
    private static readonly KeySeparator = '/'
    private static readonly DataKey = 'data'
    private static readonly Base64 = 'base64'
    private static readonly Utf8 = 'utf8'
    private static readonly MissingSecretPrefix = 'no provisioned secret for '

    public constructor(
        private readonly orchestrators: HiveOrchestratorFactory,
        private readonly directory: ITenantDirectory,
        private readonly tunnels: ClusterTunnelPool,
        private readonly spawner: IProcessSpawner)
    {
    }

    /** The env's URLs, held until the caller's Release: a Docker record's Release is a no-op. */
    public async UrlsFor(rec: EnvironmentRecord): Promise<EnvironmentUrlsLease>
    {
        if (EnvironmentEndpoints.IsLocal(rec))
        {
            return EnvironmentEndpoints.LocalUrlsOf(rec)
        }
        const { hive, kubectl } = this.Reach(rec)
        if (!KubectlCli.CanPortForward(kubectl))
        {
            throw new EnvironmentUnreachableError()
        }
        const lease = await this.tunnels.Acquire(hive.id + EnvironmentEndpoints.KeySeparator + rec.name, () => this.Forward(kubectl, rec))
        return {
            httpUrl: EnvironmentEndpoints.TunnelHttpPrefix + String(lease.LocalPort),
            wsUrl: EnvironmentEndpoints.TunnelWsPrefix + String(lease.LocalPort),
            Release: () => lease.Release(),
        }
    }

    /** The Owner password: from the local bundle (Docker) or the env Secret in the cluster (in-cluster). */
    public async AdminPasswordFor(rec: EnvironmentRecord, dataRoot: string): Promise<string>
    {
        if (EnvironmentEndpoints.IsLocal(rec))
        {
            return EnvironmentEndpoints.LocalAdminPasswordOf(rec, dataRoot)
        }
        const { kubectl } = this.Reach(rec)
        const json = await kubectl.Get(K8sManifestBuilder.NamespaceOf(rec.name), EnvironmentEndpoints.SecretPrefix + EnvServerSeedSource.SecretNameOf(rec.name))
        return EnvironmentEndpoints.SecretOf(EnvironmentEndpoints.ParseObject(EnvironmentEndpoints.SecretsFileOf(json)), EnvironmentEndpoints.AdminRefOf(rec))
    }

    /** Docker URLs for a record on this host; nothing is held, so Release is a no-op. */
    public static LocalUrlsOf(rec: EnvironmentRecord): EnvironmentUrlsLease
    {
        return {
            httpUrl: EnvironmentEndpoints.LocalHttpPrefix + String(rec.hostPort),
            wsUrl: EnvironmentEndpoints.LocalWsPrefix + String(rec.hostPort),
            Release: () => undefined,
        }
    }

    /** A Docker record's Owner password from its local bundle (`bundleDir`, else `<dataRoot>/<name>`). */
    public static async LocalAdminPasswordOf(rec: EnvironmentRecord, dataRoot: string): Promise<string>
    {
        const bundleDir = rec.bundleDir ?? join(dataRoot, rec.name)
        const text = await readFile(join(bundleDir, EnvServerSeedSource.SecretsFile), EnvironmentEndpoints.Utf8)
        return EnvironmentEndpoints.SecretOf(EnvironmentEndpoints.ParseObject(text), EnvironmentEndpoints.AdminRefOf(rec))
    }

    /** A record with a host port is a Docker environment on this host. */
    public static IsLocal(rec: EnvironmentRecord): boolean
    {
        return rec.hostPort !== undefined
    }

    private Forward(kubectl: IPortForwardingKubectl, rec: EnvironmentRecord): ReturnType<IPortForwardingKubectl['PortForward']>
    {
        const target = EnvironmentEndpoints.ServicePrefix + K8sManifestBuilder.ServerDeploymentOf(rec.name)
        return kubectl.PortForward(K8sManifestBuilder.NamespaceOf(rec.name), target, EnvironmentWorkloadFactory.ServerPort, this.spawner)
    }

    private Reach(rec: EnvironmentRecord): { hive: HiveRecord; kubectl: IKubectl }
    {
        const hive = rec.hiveId === undefined ? undefined : this.directory.GetHive(rec.hiveId)
        if (hive === undefined)
        {
            throw new EnvironmentUnreachableError()
        }
        let kubectl: IKubectl | undefined
        try
        {
            kubectl = this.orchestrators.For(hive).Kubectl
        }
        catch (err)
        {
            if (err instanceof UnsupportedBackendError)
            {
                throw new EnvironmentUnreachableError()
            }
            throw err
        }
        if (kubectl === undefined || kubectl === null)
        {
            throw new EnvironmentUnreachableError()
        }
        return { hive, kubectl }
    }

    private static AdminRefOf(rec: EnvironmentRecord): string
    {
        return rec.environmentId + BundleBuilder.AdminSecretSuffix
    }

    /** The decoded provisioned-secrets file text from a `kubectl get secret -o json` document. */
    private static SecretsFileOf(secretJson: string): string
    {
        const data = (EnvironmentEndpoints.ParseObject(secretJson)[EnvironmentEndpoints.DataKey] ?? {}) as Record<string, unknown>
        const encoded = data[EnvServerSeedSource.SecretsFile]
        if (typeof encoded !== 'string')
        {
            throw new EnvironmentSecretsUnreadableError()
        }
        return Buffer.from(encoded, EnvironmentEndpoints.Base64).toString(EnvironmentEndpoints.Utf8)
    }

    // JSON.parse messages can quote the input, which here is secret material: they are replaced by a fixed message.
    private static ParseObject(text: string): Record<string, unknown>
    {
        let parsed: unknown
        try
        {
            parsed = JSON.parse(text)
        }
        catch
        {
            throw new EnvironmentSecretsUnreadableError()
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        {
            throw new EnvironmentSecretsUnreadableError()
        }
        return parsed as Record<string, unknown>
    }

    private static SecretOf(secrets: Record<string, unknown>, ref: string): string
    {
        const value = secrets[ref]
        if (typeof value !== 'string')
        {
            throw new Error(EnvironmentEndpoints.MissingSecretPrefix + ref)
        }
        return value
    }
}
