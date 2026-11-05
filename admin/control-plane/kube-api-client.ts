import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { KubeHttpsTransport, KubeServiceAccountDefaults } from '../../src/agent/kube-https-transport.js'
import { KubectlError } from './kubectl.js'

export enum KubeMethod
{
    Get = 'GET',
    Post = 'POST',
    Patch = 'PATCH',
    Delete = 'DELETE',
}

export enum KubeContentType
{
    Json = 'application/json',
    ApplyPatch = 'application/apply-patch+yaml',
    StrategicMerge = 'application/strategic-merge-patch+json',
    MergePatch = 'application/merge-patch+json',
}

export type KubeResponse = { status: number; body: string }

export interface IKubeTransport
{
    Send(method: KubeMethod, path: string, body: string | undefined, contentType: KubeContentType): Promise<KubeResponse>
}

/** The pod's service account mount: present only when running inside a cluster. */
export class InClusterServiceAccount
{
    public static readonly DefaultRoot = KubeServiceAccountDefaults.Root
    public static readonly Host = KubeServiceAccountDefaults.Host
    private static readonly HostEnv = 'KUBERNETES_SERVICE_HOST'

    public constructor(public readonly TokenPath: string, public readonly CaPath: string)
    {
    }

    /** Present only when KUBERNETES_SERVICE_HOST is set AND `<root>/token` and `<root>/ca.crt` exist. */
    public static Detect(env: NodeJS.ProcessEnv, root: string = InClusterServiceAccount.DefaultRoot): InClusterServiceAccount | undefined
    {
        const host = env[InClusterServiceAccount.HostEnv]
        if (host === undefined || host === '')
        {
            return undefined
        }
        const tokenPath = join(root, KubeServiceAccountDefaults.TokenFile)
        const caPath = join(root, KubeServiceAccountDefaults.CaFile)
        return existsSync(tokenPath) && existsSync(caPath) ? new InClusterServiceAccount(tokenPath, caPath) : undefined
    }
}

/** node:https transport to the API server; the shared src/agent round trip rereads the token on every request. */
export class HttpsKubeTransport implements IKubeTransport
{
    private readonly https: KubeHttpsTransport

    public constructor(account: InClusterServiceAccount, timeoutMs: number = 30000, host: string = InClusterServiceAccount.Host, port?: number)
    {
        this.https = new KubeHttpsTransport(account.TokenPath, account.CaPath, host, port, timeoutMs)
    }

    public Send(method: KubeMethod, path: string, body: string | undefined, contentType: KubeContentType): Promise<KubeResponse>
    {
        return this.https.Send(method, path, body, contentType)
    }
}

export type KubeTypeRef = { apiVersion: string; kind: string }

type KubeKindEntry = { apiVersion: string; kind: string; plural: string; namespaced: boolean; short?: string }

export class UnsupportedKubeKindError extends KubectlError
{
    private static readonly KindPrefix = 'Unsupported Kubernetes kind: '
    private static readonly KindErrorName = 'UnsupportedKubeKindError'

    public constructor(description: string)
    {
        super(UnsupportedKubeKindError.KindPrefix + description, '', false)
        this.name = UnsupportedKubeKindError.KindErrorName
    }
}

export class KubeResourceCatalog
{
    /** The cluster-scoped Namespace type: the one home shared by ApiKubectl, the env guard and the in-cluster orchestrator. */
    public static readonly NamespaceType: KubeTypeRef = { apiVersion: 'v1', kind: 'Namespace' }
    /** The kind of a manifest that wraps several objects in `items`. */
    public static readonly ListKind = 'List'
    private static readonly CoreVersion = 'v1'
    private static readonly CoreRoot = '/api/'
    private static readonly GroupRoot = '/apis/'
    private static readonly Slash = '/'
    private static readonly NamespacesSegment = 'namespaces/'
    private static readonly Entries: ReadonlyArray<KubeKindEntry> = [
        { apiVersion: 'v1', kind: 'Namespace', plural: 'namespaces', namespaced: false },
        { apiVersion: 'v1', kind: 'Secret', plural: 'secrets', namespaced: true },
        { apiVersion: 'v1', kind: 'Pod', plural: 'pods', namespaced: true, short: 'po' },
        { apiVersion: 'v1', kind: 'ConfigMap', plural: 'configmaps', namespaced: true },
        { apiVersion: 'v1', kind: 'Service', plural: 'services', namespaced: true, short: 'svc' },
        { apiVersion: 'v1', kind: 'ServiceAccount', plural: 'serviceaccounts', namespaced: true },
        { apiVersion: 'v1', kind: 'PersistentVolumeClaim', plural: 'persistentvolumeclaims', namespaced: true },
        { apiVersion: 'apps/v1', kind: 'Deployment', plural: 'deployments', namespaced: true },
        { apiVersion: 'apps/v1', kind: 'StatefulSet', plural: 'statefulsets', namespaced: true },
        { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', plural: 'ingresses', namespaced: true },
        { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', plural: 'networkpolicies', namespaced: true, short: 'netpol' },
        { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', plural: 'roles', namespaced: true },
        { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', plural: 'rolebindings', namespaced: true },
        { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', plural: 'clusterroles', namespaced: false },
        { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', plural: 'clusterrolebindings', namespaced: false },
        { apiVersion: 'admissionregistration.k8s.io/v1', kind: 'ValidatingAdmissionPolicy', plural: 'validatingadmissionpolicies', namespaced: false },
        { apiVersion: 'admissionregistration.k8s.io/v1', kind: 'ValidatingAdmissionPolicyBinding', plural: 'validatingadmissionpolicybindings', namespaced: false },
    ]

    /** `/api/v1/...` or `/apis/<group>/<version>/...`, `namespaces/<ns>/` only for namespaced kinds, `/<name>` when given. */
    public static PathOf(type: KubeTypeRef, namespace: string | undefined, name?: string): string
    {
        const entry = KubeResourceCatalog.EntryOf(type)
        const root = entry.apiVersion === KubeResourceCatalog.CoreVersion
            ? KubeResourceCatalog.CoreRoot + entry.apiVersion
            : KubeResourceCatalog.GroupRoot + entry.apiVersion
        let path = root + KubeResourceCatalog.Slash
        if (entry.namespaced && namespace !== undefined)
        {
            path += KubeResourceCatalog.NamespacesSegment + encodeURIComponent(namespace) + KubeResourceCatalog.Slash
        }
        path += entry.plural
        if (name !== undefined)
        {
            path += KubeResourceCatalog.Slash + encodeURIComponent(name)
        }
        return path
    }

    /** kubectl-style 'kind/name' or a bare plural/singular/short name to a type + optional name. */
    public static ParseResource(resource: string): { type: KubeTypeRef; name: string | undefined }
    {
        const cut = resource.indexOf(KubeResourceCatalog.Slash)
        const word = (cut < 0 ? resource : resource.slice(0, cut)).toLowerCase()
        const name = cut < 0 ? undefined : resource.slice(cut + 1)
        const entry = KubeResourceCatalog.Entries.find(e =>
            e.plural === word || e.kind.toLowerCase() === word || e.short === word)
        if (entry === undefined)
        {
            throw new UnsupportedKubeKindError(resource)
        }
        return { type: { apiVersion: entry.apiVersion, kind: entry.kind }, name: name === '' ? undefined : name }
    }

    public static IsNamespaced(type: KubeTypeRef): boolean
    {
        return KubeResourceCatalog.EntryOf(type).namespaced
    }

    private static EntryOf(type: KubeTypeRef): KubeKindEntry
    {
        const entry = KubeResourceCatalog.Entries.find(e => e.apiVersion === type.apiVersion && e.kind === type.kind)
        if (entry === undefined)
        {
            throw new UnsupportedKubeKindError(type.apiVersion + KubeResourceCatalog.Slash + type.kind)
        }
        return entry
    }
}

export class KubeApiError extends KubectlError
{
    private static readonly ApiPrefix = 'kubernetes API '
    private static readonly Middle = ' failed with status '
    private static readonly Space = ' '
    private static readonly Separator = ': '
    private static readonly ApiErrorName = 'KubeApiError'

    public constructor(public readonly Status: number, method: KubeMethod, path: string, apiMessage: string | undefined)
    {
        super(KubeApiError.ApiPrefix + method + KubeApiError.Space + path + KubeApiError.Middle + Status
            + (apiMessage === undefined || apiMessage === '' ? '' : KubeApiError.Separator + KubectlError.Redact(apiMessage).trim()), '', false)
        this.name = KubeApiError.ApiErrorName
    }
}

export class KubeApiClient
{
    public static readonly FieldManager = 'pragmatic-tenant-console'
    private static readonly ApplyQuery = '?fieldManager=' + KubeApiClient.FieldManager + '&force=true'
    private static readonly LabelSelectorQuery = '?labelSelector='
    private static readonly BadJsonMessage = 'kubernetes API GET response was not valid JSON'
    private static readonly NotFound = 404
    private static readonly Conflict = 409
    private static readonly OkMin = 200
    private static readonly OkMax = 299

    public constructor(private readonly transport: IKubeTransport)
    {
    }

    public async Get(path: string): Promise<unknown | undefined>
    {
        const response = await this.transport.Send(KubeMethod.Get, path, undefined, KubeContentType.Json)
        if (response.status === KubeApiClient.NotFound)
        {
            return undefined
        }
        KubeApiClient.EnsureOk(response, KubeMethod.Get, path)
        return KubeApiClient.ParseJson(response.body)
    }

    public async List(path: string, labelSelector?: string): Promise<unknown[]>
    {
        const target = labelSelector === undefined ? path : path + KubeApiClient.LabelSelectorQuery + encodeURIComponent(labelSelector)
        const response = await this.transport.Send(KubeMethod.Get, target, undefined, KubeContentType.Json)
        KubeApiClient.EnsureOk(response, KubeMethod.Get, path)
        const list = KubeApiClient.ParseJson(response.body) as { items?: unknown[] }
        return list.items ?? []
    }

    public async Create(path: string, body: object): Promise<boolean>
    {
        const response = await this.transport.Send(KubeMethod.Post, path, JSON.stringify(body), KubeContentType.Json)
        if (response.status === KubeApiClient.Conflict)
        {
            return false
        }
        KubeApiClient.EnsureOk(response, KubeMethod.Post, path)
        return true
    }

    public async Apply(path: string, body: object): Promise<void>
    {
        const response = await this.transport.Send(KubeMethod.Patch, path + KubeApiClient.ApplyQuery, JSON.stringify(body), KubeContentType.ApplyPatch)
        KubeApiClient.EnsureOk(response, KubeMethod.Patch, path)
    }

    public async Patch(path: string, body: object, type: KubeContentType): Promise<void>
    {
        const response = await this.transport.Send(KubeMethod.Patch, path, JSON.stringify(body), type)
        KubeApiClient.EnsureOk(response, KubeMethod.Patch, path)
    }

    public async Delete(path: string): Promise<boolean>
    {
        const response = await this.transport.Send(KubeMethod.Delete, path, undefined, KubeContentType.Json)
        if (response.status === KubeApiClient.NotFound)
        {
            return false
        }
        KubeApiClient.EnsureOk(response, KubeMethod.Delete, path)
        return true
    }

    private static EnsureOk(response: KubeResponse, method: KubeMethod, path: string): void
    {
        if (response.status >= KubeApiClient.OkMin && response.status <= KubeApiClient.OkMax)
        {
            return
        }
        throw new KubeApiError(response.status, method, path, KubeApiClient.MessageOf(response.body))
    }

    /** The SyntaxError text can echo a body snippet (a Secret GET), so a bad body fails with a fixed message. */
    private static ParseJson(body: string): unknown
    {
        try
        {
            return JSON.parse(body) as unknown
        }
        catch
        {
            throw new KubectlError(KubeApiClient.BadJsonMessage, '', false)
        }
    }

    private static MessageOf(body: string): string | undefined
    {
        try
        {
            const parsed = JSON.parse(body) as { message?: unknown }
            return typeof parsed.message === 'string' ? parsed.message : undefined
        }
        catch
        {
            return undefined
        }
    }
}
