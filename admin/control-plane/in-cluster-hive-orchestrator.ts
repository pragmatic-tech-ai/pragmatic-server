import type { EnvironmentWorkload } from './environment-workload.js'
import type { IHiveOrchestrator, WorkloadHealth } from './hive-orchestrator.js'
import type { IKubectl } from './kubectl.js'
import type { EffectiveRegistry } from './effective-registry.js'
import type { IImageVerifier } from './image-verifier.js'
import { ApiKubectl } from './api-kubectl.js'
import { EnvNamespaceGuard, EnvNamespaceRefusal, EnvNamespaceRefusedError } from './env-namespace-guard.js'
import { SystemInstallClock, type IInstallClock } from './hive-agent-installer.js'
import { IngressTlsPolicy, IngressTlsSource, type IngressTls } from './ingress-tls.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { KubeApiClient, KubeApiError, KubeResourceCatalog, type KubeTypeRef } from './kube-api-client.js'
import { KubectlHiveOrchestrator, type OrchestratorPolling } from './kubectl-hive-orchestrator.js'

/** Which tenant console this is and which hive it runs in. */
export type ConsoleIdentity = { tenantId: string; hiveId: string }

/** What the console needs to orchestrate its own hive from inside the cluster. TLS comes from each workload's placement. */
export type InClusterOrchestration = { client: KubeApiClient; identity: ConsoleIdentity; verifier: IImageVerifier }

/** The TLS source Secret to copy is missing or not a usable kubernetes.io/tls Secret; names the Secret only, never its data. */
export class InvalidTlsSourceSecretError extends Error
{
    private static readonly ErrorName = 'InvalidTlsSourceSecretError'
    private static readonly MessagePrefix = 'The TLS Secret '
    private static readonly MessageSuffix = ' must exist and be of type kubernetes.io/tls with tls.crt and tls.key.'
    private static readonly Slash = '/'

    public constructor(namespace: string, name: string)
    {
        super(InvalidTlsSourceSecretError.MessagePrefix + namespace + InvalidTlsSourceSecretError.Slash + name + InvalidTlsSourceSecretError.MessageSuffix)
        this.name = InvalidTlsSourceSecretError.ErrorName
    }
}

type ManifestItem = { apiVersion: string; kind: string; metadata: { name: string; namespace?: string } }

type TlsSourceSecret = { type?: unknown; data?: Record<string, unknown> }

/**
 * Drives the console's own hive through the Kubernetes API from inside the console pod. Everything it writes is fenced to the
 * `pragmatic-env-*` namespaces of this hive (EnvNamespaceGuard client-side, TenantConsoleAdmission server-side). Apply creates
 * the namespace and the console's env RoleBinding by POST (the console has no patch on either), then applies the rest, retrying
 * the 403s RBAC propagation of the fresh binding produces.
 */
export class InClusterHiveOrchestrator implements IHiveOrchestrator
{
    public static readonly BindingRetry: OrchestratorPolling = { attempts: 20, intervalMs: 500 }

    private static readonly NamespaceType: KubeTypeRef = { apiVersion: 'v1', kind: 'Namespace' }
    private static readonly RoleBindingType: KubeTypeRef = { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding' }
    private static readonly SecretType: KubeTypeRef = { apiVersion: 'v1', kind: 'Secret' }
    private static readonly RbacApiGroup = 'rbac.authorization.k8s.io'
    private static readonly ClusterRoleKind = 'ClusterRole'
    private static readonly ServiceAccountKind = 'ServiceAccount'
    private static readonly ListKind = 'List'
    private static readonly TlsCertKey = 'tls.crt'
    private static readonly TlsKeyKey = 'tls.key'
    private static readonly Forbidden = 403

    private readonly kubectl: IKubectl
    private readonly manifests = new K8sManifestBuilder()
    private readonly inner: KubectlHiveOrchestrator

    public constructor(
        private readonly setup: InClusterOrchestration,
        private readonly registry: EffectiveRegistry,
        private readonly trustRootRef: string | undefined,
        private readonly clock: IInstallClock = new SystemInstallClock(),
        polling: OrchestratorPolling = KubectlHiveOrchestrator.DefaultPolling)
    {
        this.kubectl = new EnvNamespaceGuard(new ApiKubectl(setup.client, clock))
        this.inner = new KubectlHiveOrchestrator(this.kubectl, this.manifests, registry, setup.verifier, trustRootRef, polling)
    }

    public get Kubectl(): IKubectl
    {
        return this.kubectl
    }

    public async Apply(w: EnvironmentWorkload): Promise<void>
    {
        const ns = K8sManifestBuilder.NamespaceOf(w.environmentName)
        EnvNamespaceGuard.AssertEnvNamespace(ns)
        if (w.hiveId !== this.setup.identity.hiveId)
        {
            throw new EnvNamespaceRefusedError(ns, EnvNamespaceRefusal.OtherHive)
        }
        const image = this.registry.ImageRef(w.image)
        await this.setup.verifier.Verify(image, this.trustRootRef)
        const items = InClusterHiveOrchestrator.ItemsOf(this.manifests.Render({ ...w, image }))
        const namespaceItem = items.find(i => InClusterHiveOrchestrator.IsNamespace(i) && i.metadata.name === ns)
        const rest = items.filter(i => i !== namespaceItem)
        if (namespaceItem !== undefined)
        {
            await this.CreateNamespace(ns, namespaceItem)
        }
        await this.CreateConsoleBinding(ns)
        const tls = w.federation?.ingressTls
        if (tls !== undefined && IngressTlsPolicy.CopiesSecret(tls))
        {
            await this.CopyTlsSecret(ns, tls, K8sManifestBuilder.ServerDeploymentOf(w.environmentName))
        }
        const manifest = JSON.stringify({ apiVersion: InClusterHiveOrchestrator.NamespaceType.apiVersion, kind: InClusterHiveOrchestrator.ListKind, items: rest })
        await this.RetryingForbidden(() => this.kubectl.Apply(manifest))
    }

    public WaitHealthy(w: EnvironmentWorkload): Promise<void>
    {
        return this.inner.WaitHealthy(w)
    }

    public Health(w: EnvironmentWorkload): Promise<WorkloadHealth>
    {
        return this.inner.Health(w)
    }

    public Roll(w: EnvironmentWorkload, image: string): Promise<void>
    {
        return this.inner.Roll(w, image)
    }

    public Scale(workload: EnvironmentWorkload, replicas: number): Promise<void>
    {
        return this.inner.Scale(workload, replicas)
    }

    public ScaleDatabase(workload: EnvironmentWorkload, replicas: number): Promise<void>
    {
        return this.inner.ScaleDatabase(workload, replicas)
    }

    /** Deletes the environment namespace only when it is labelled for this hive; an absent namespace is already done. */
    public async Teardown(w: EnvironmentWorkload): Promise<void>
    {
        const ns = K8sManifestBuilder.NamespaceOf(w.environmentName)
        EnvNamespaceGuard.AssertEnvNamespace(ns)
        const existing = await this.setup.client.Get(InClusterHiveOrchestrator.NamespacePath(ns))
        if (existing === undefined)
        {
            return
        }
        InClusterHiveOrchestrator.AssertOwned(existing, ns, this.setup.identity.hiveId)
        await this.kubectl.DeleteNamespace(ns)
    }

    /** The console runs inside the hive it orchestrates: nothing to prepare. */
    public async PrepareAgent(_image: string): Promise<void>
    {
    }

    /** POST the Namespace (no patch: the admission fence admits only creates); on 409 adopt it only when it is this hive's. */
    private async CreateNamespace(ns: string, item: ManifestItem): Promise<void>
    {
        const created = await this.setup.client.Create(KubeResourceCatalog.PathOf(InClusterHiveOrchestrator.NamespaceType, undefined), item)
        if (created)
        {
            return
        }
        const existing = await this.setup.client.Get(InClusterHiveOrchestrator.NamespacePath(ns))
        InClusterHiveOrchestrator.AssertOwned(existing, ns, this.setup.identity.hiveId)
    }

    /** Binds the console's env ClusterRole to its ServiceAccount inside the namespace; an existing binding (409) is fine. */
    private async CreateConsoleBinding(ns: string): Promise<void>
    {
        const { tenantId, hiveId } = this.setup.identity
        const C = InClusterHiveOrchestrator
        const body = {
            apiVersion: C.RoleBindingType.apiVersion,
            kind: C.RoleBindingType.kind,
            metadata: { name: K8sManifestBuilder.TenantConsoleEnvBindingName, namespace: ns, labels: K8sManifestBuilder.HiveLabelsOf(hiveId) },
            roleRef: { apiGroup: C.RbacApiGroup, kind: C.ClusterRoleKind, name: K8sManifestBuilder.TenantConsoleEnvRoleNameOf(tenantId) },
            subjects: [{ kind: C.ServiceAccountKind, name: K8sManifestBuilder.TenantAdminNameOf(tenantId), namespace: K8sManifestBuilder.SystemNamespace }],
        }
        await this.setup.client.Create(KubeResourceCatalog.PathOf(C.RoleBindingType, ns), body)
    }

    /**
     * Reads the TLS source from pragmatic-system through the client (the console's TLS Role grants `get` on exactly that Secret;
     * the env guard would refuse it) and writes only its type, tls.crt and tls.key into `ns` through the guarded kubectl, under the
     * name the environment's Ingress serves.
     */
    private async CopyTlsSecret(ns: string, tls: IngressTls, ingressName: string): Promise<void>
    {
        const C = InClusterHiveOrchestrator
        const source = tls.source === IngressTlsSource.Development
            ? K8sManifestBuilder.TenantConsoleDevTlsSecretNameOf(this.setup.identity.tenantId)
            : IngressTlsPolicy.SecretNameFor(tls, ingressName)
        const system = K8sManifestBuilder.SystemNamespace
        const found = await this.setup.client.Get(KubeResourceCatalog.PathOf(C.SecretType, system, source)) as TlsSourceSecret | undefined
        const cert = found?.data?.[C.TlsCertKey]
        const key = found?.data?.[C.TlsKeyKey]
        if (found?.type !== IngressTlsPolicy.TlsSecretType || typeof cert !== 'string' || typeof key !== 'string')
        {
            throw new InvalidTlsSourceSecretError(system, source)
        }
        const copy = {
            apiVersion: C.SecretType.apiVersion,
            kind: C.SecretType.kind,
            metadata: { name: IngressTlsPolicy.SecretNameFor(tls, ingressName), namespace: ns },
            type: IngressTlsPolicy.TlsSecretType,
            data: { [C.TlsCertKey]: cert, [C.TlsKeyKey]: key },
        }
        const manifest = JSON.stringify(copy)
        await this.RetryingForbidden(() => this.kubectl.ApplyServerSide(manifest))
    }

    /** A freshly created RoleBinding takes a moment to reach the authorizer: retry 403s up to BindingRetry, then rethrow. */
    private async RetryingForbidden(action: () => Promise<void>): Promise<void>
    {
        const { attempts, intervalMs } = InClusterHiveOrchestrator.BindingRetry
        for (let attempt = 1; ; attempt++)
        {
            try
            {
                await action()
                return
            }
            catch (e)
            {
                if (!(e instanceof KubeApiError) || e.Status !== InClusterHiveOrchestrator.Forbidden || attempt >= attempts)
                {
                    throw e
                }
            }
            await this.clock.Delay(intervalMs)
        }
    }

    private static AssertOwned(existing: unknown, ns: string, hiveId: string): void
    {
        // A namespace that vanished between the 409 and the read is not ours to adopt either.
        EnvNamespaceGuard.AssertHiveOwns(existing ?? {}, ns, hiveId)
    }

    private static NamespacePath(ns: string): string
    {
        return KubeResourceCatalog.PathOf(InClusterHiveOrchestrator.NamespaceType, undefined, ns)
    }

    private static IsNamespace(item: ManifestItem): boolean
    {
        return item.apiVersion === InClusterHiveOrchestrator.NamespaceType.apiVersion && item.kind === InClusterHiveOrchestrator.NamespaceType.kind
    }

    private static ItemsOf(manifestJson: string): ManifestItem[]
    {
        return (JSON.parse(manifestJson) as { items: ManifestItem[] }).items
    }
}
