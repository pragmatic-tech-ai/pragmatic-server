import type { EnvironmentRecord } from './environment-record.js'
import { EnvironmentEndpoints, EnvironmentUnreachableError, type EnvironmentUrlsLease, type IEnvironmentReach } from './environment-endpoints.js'
import { EnvServerSeedSource } from './env-server-seed.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import type { IKubectl } from './kubectl.js'

/**
 * How the tenant console, running as a pod inside its hive, reaches an environment: by cluster DNS (the environment's
 * recorded endpoint, reduced to scheme://host:port - no tunnel, so nothing is held), and the Owner password from the
 * `<env>-env-secrets` Secret read through the guarded API kubectl. A Docker record keeps its local bundle.
 */
export class InClusterEnvironmentReach implements IEnvironmentReach
{
    private static readonly SecretPrefix = 'secret/'
    private static readonly AuthorityMarker = '//'

    public constructor(private readonly kubectl: IKubectl)
    {
    }

    /** record.endpoint as origin-only URLs; Release and Fail are no-ops. Unreachable when the record has no endpoint. */
    public UrlsFor(rec: EnvironmentRecord): Promise<EnvironmentUrlsLease>
    {
        if (EnvironmentEndpoints.IsLocal(rec))
        {
            return Promise.resolve(EnvironmentEndpoints.LocalUrlsOf(rec))
        }
        if (rec.endpoint === undefined)
        {
            return Promise.reject(new EnvironmentUnreachableError())
        }
        return Promise.resolve({
            httpUrl: new URL(rec.endpoint.httpUrl).origin,
            wsUrl: InClusterEnvironmentReach.WsOriginOf(rec.endpoint.wsUrl),
            Release: () => undefined,
            Fail: () => undefined,
        })
    }

    /** Docker record: the local bundle; otherwise `<env>-env-secrets` read through the guarded API kubectl. */
    public async AdminPasswordFor(rec: EnvironmentRecord, dataRoot: string): Promise<string>
    {
        if (EnvironmentEndpoints.IsLocal(rec))
        {
            return EnvironmentEndpoints.LocalAdminPasswordOf(rec, dataRoot)
        }
        const json = await this.kubectl.Get(K8sManifestBuilder.NamespaceOf(rec.name), InClusterEnvironmentReach.SecretPrefix + EnvServerSeedSource.SecretNameOf(rec.name))
        return EnvironmentEndpoints.AdminPasswordFromSecretJson(rec, json)
    }

    /** `new URL(...).origin` is opaque for ws:/wss:, so the origin is rebuilt from protocol + host. */
    private static WsOriginOf(wsUrl: string): string
    {
        const url = new URL(wsUrl)
        return url.protocol + InClusterEnvironmentReach.AuthorityMarker + url.host
    }
}
