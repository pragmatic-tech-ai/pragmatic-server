import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AgentUninstallError, ConsoleUninstallError, HiveAgentUninstaller } from '../hive-agent-uninstaller.js'
import { HiveBootstrapBundle } from '../hive-bootstrap-bundle.js'
import { InClusterIdpSeedSource } from '../in-cluster-idp-seed.js'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import type { IHiveOrchestrator, WorkloadHealth } from '../hive-orchestrator.js'
import { KubectlError, type IKubectl } from '../kubectl.js'
import type { EnvironmentWorkload } from '../environment-workload.js'
import { HiveBackend, InfraMode, type HiveRecord } from '../platform-records.js'

class FakeKubectl implements IKubectl
{
    public readonly Calls: string[][] = []
    // What exists in the cluster: resource ('kind/name') -> its JSON.
    public readonly Objects = new Map<string, string>()
    public DeleteManifestError: Error | undefined
    public DeleteSelectorError: Error | undefined

    public async Find(namespace: string, resource: string): Promise<string | undefined>
    {
        this.Calls.push(['Find', namespace, resource])
        return this.Objects.get(resource)
    }

    public async DeleteManifest(manifestJson: string): Promise<void>
    {
        this.Calls.push(['DeleteManifest', manifestJson])
        if (this.DeleteManifestError !== undefined)
        {
            throw this.DeleteManifestError
        }
    }

    public async DeleteBySelector(namespace: string, resource: string, selector: string): Promise<void>
    {
        this.Calls.push(['DeleteBySelector', namespace, resource, selector])
        if (this.DeleteSelectorError !== undefined)
        {
            throw this.DeleteSelectorError
        }
    }

    public FailedNamespaces: string[] = []
    public NamespaceListError: Error | undefined

    public async DeleteNamespacesBySelector(selector: string, namePrefix: string): Promise<string[]>
    {
        this.Calls.push(['DeleteNamespacesBySelector', selector, namePrefix])
        if (this.NamespaceListError !== undefined)
        {
            throw this.NamespaceListError
        }
        return this.FailedNamespaces
    }

    public async ListNamespacesBySelector(_selector: string, _namePrefix: string): Promise<string[]> { return [] }

    public ServesAdmission = true

    public async ServesResource(groupVersion: string, resource: string): Promise<boolean>
    {
        this.Calls.push(['ServesResource', groupVersion, resource])
        return this.ServesAdmission
    }

    public async Apply(_m: string): Promise<void> { this.Calls.push(['Apply']) }
    public async ApplyServerSide(_m: string): Promise<void> { this.Calls.push(['ApplyServerSide']) }
    public async RolloutStatus(_n: string, _d: string): Promise<void> { }
    public async SetImage(_n: string, _d: string, _c: string, _i: string): Promise<void> { }
    public async Scale(_n: string, _d: string, _r: number): Promise<void> { }
    public async ScaleStatefulSet(_n: string, _s: string, _r: number): Promise<void> { }
    public async RolloutRestart(_n: string, _d: string): Promise<void> { }
    public async RolloutRestartSelector(_n: string, _s: string): Promise<void> { }
    public async Get(_n: string, _r: string): Promise<string> { return '{}' }
    public async DeleteNamespace(n: string): Promise<void> { this.Calls.push(['DeleteNamespace', n]) }
}

class FakeOrchestrators
{
    public readonly Kubectl = new FakeKubectl()
    public readonly Resolved: string[] = []
    public ResolveError: Error | undefined

    public For(hive: HiveRecord): IHiveOrchestrator
    {
        this.Resolved.push(hive.id)
        if (this.ResolveError !== undefined)
        {
            throw this.ResolveError
        }
        const kubectl = this.Kubectl
        return {
            Kubectl: kubectl,
            Apply: async (_w: EnvironmentWorkload) => undefined,
            WaitHealthy: async (_w: EnvironmentWorkload) => undefined,
            Health: async (_w: EnvironmentWorkload): Promise<WorkloadHealth> => ({ ready: true, runningImage: undefined, detail: '' }),
            Roll: async (_w: EnvironmentWorkload, _i: string) => undefined,
            Scale: async (_w: EnvironmentWorkload, _r: number) => undefined,
            ScaleDatabase: async (_w: EnvironmentWorkload, _r: number) => undefined,
            Teardown: async (_w: EnvironmentWorkload) => undefined,
            PrepareAgent: async (_i: string) => undefined,
        }
    }
}

class Fixture
{
    public readonly Orchestrators = new FakeOrchestrators()
    public readonly Uninstaller = new HiveAgentUninstaller(this.Orchestrators)

    // A tenant-admin Deployment as kubectl returns it, labelled for a hive.
    public static Deployment(hiveId: string): string
    {
        return JSON.stringify({ kind: 'Deployment', metadata: { name: 'x', labels: { 'pragmatic/hive': hiveId } } })
    }

    public static Hive(id: string, backend: HiveBackend, mode: InfraMode): HiveRecord
    {
        return { id, tenantId: 't1', displayName: id, cluster: { backend, mode }, registry: { mode: InfraMode.Provision }, createdAt: '2026-01-01T00:00:00.000Z' }
    }
}

describe('HiveAgentUninstaller', () =>
{
    it('covers attached Local hives only: a provisioned cluster is destroyed whole, other backends are never touched', () =>
    {
        const fx = new Fixture()
        assert.equal(fx.Uninstaller.Covers(Fixture.Hive('h1', HiveBackend.Local, InfraMode.Attach)), true)
        assert.equal(fx.Uninstaller.Covers(Fixture.Hive('k1', HiveBackend.Local, InfraMode.Provision)), false)
        assert.equal(fx.Uninstaller.Covers(Fixture.Hive('a1', HiveBackend.Aks, InfraMode.Attach)), false)
    })

    it('deletes the bundle objects, the token Secret and (no tenant-admin elsewhere) the credential copies by name, then the hive-labelled stateless objects', async () =>
    {
        const fx = new Fixture()
        const retained = await fx.Uninstaller.Uninstall(Fixture.Hive('h1', HiveBackend.Local, InfraMode.Attach))
        assert.deepEqual(fx.Orchestrators.Resolved, ['h1'])
        assert.deepEqual(fx.Orchestrators.Kubectl.Calls, [
            ['DeleteManifest', HiveBootstrapBundle.RemovalManifest('h1')],
            ['Find', 'pragmatic-system', 'deployment/' + K8sManifestBuilder.TenantAdminNameOf('t1')],
            ['ServesResource', 'admissionregistration.k8s.io/v1', 'validatingadmissionpolicies'],
            ['ServesResource', 'admissionregistration.k8s.io/v1', 'validatingadmissionpolicybindings'],
            ['DeleteManifest', new K8sManifestBuilder().TenantConsoleRemovalManifest('t1', 'h1')],
            ['DeleteBySelector', 'pragmatic-system', 'deployment,service,serviceaccount,secret', 'pragmatic/hive=h1'],
            ['Find', 'pragmatic-system', 'persistentvolumeclaim/' + K8sManifestBuilder.TenantAdminClaimNameOf('t1')],
            ['Find', 'pragmatic-system', 'secret/' + K8sManifestBuilder.TenantAdminSeedSecretNameOf('t1')],
            ['Find', K8sManifestBuilder.IdpNameOf('t1'), 'persistentvolumeclaim/' + K8sManifestBuilder.IdpClaimNameOf('t1')],
            ['Find', K8sManifestBuilder.IdpNameOf('t1'), 'secret/' + InClusterIdpSeedSource.TlsSecretNameOf('t1')],
            ['Find', K8sManifestBuilder.IdpNameOf('t1'), 'secret/' + InClusterIdpSeedSource.AdminSecretNameOf('t1')],
        ])
        // Nothing retained exists here, so nothing is reported.
        assert.deepEqual(retained, [])
        // The tenant-admin data PVC and its seed Secret (the master key that decrypts it) are never deleted.
        const deletes = JSON.stringify(fx.Orchestrators.Kubectl.Calls.filter(c => c[0] !== 'Find'))
        assert.ok(!deletes.includes(K8sManifestBuilder.TenantAdminClaimNameOf('t1')))
        assert.ok(!deletes.includes(K8sManifestBuilder.TenantAdminSeedSecretNameOf('t1')))
        assert.ok(!deletes.includes('persistentvolumeclaim'))
        // The shared namespace stays: other hives' agents may live in it.
        assert.ok(!fx.Orchestrators.Kubectl.Calls.some(c => c[0] === 'DeleteNamespace'))
    })

    it('a kubectl failure becomes AgentUninstallError with the redacted reason and the retry / delete-anyway guidance', async () =>
    {
        const fx = new Fixture()
        fx.Orchestrators.Kubectl.DeleteManifestError = new KubectlError('Unable to connect to the server: dial tcp 127.0.0.1:6443\ntoken: abcdefghijabcdefghijabcdefghij0123456789')
        const err = await fx.Uninstaller.Uninstall(Fixture.Hive('h1', HiveBackend.Local, InfraMode.Attach)).then(() => undefined, (e: unknown) => e)
        assert.ok(err instanceof AgentUninstallError)
        assert.match(err.message, /^Could not remove the hive's agent from its cluster: kubectl failed: Unable to connect to the server/)
        assert.match(err.message, /Fix cluster access and retry, or delete anyway to remove only the platform record\.$/)
        assert.ok(!err.message.includes('abcdefghijabcdefghij'))
        assert.equal(AgentUninstallError.Code, 'agent-uninstall-failed')
        assert.equal(fx.Orchestrators.Kubectl.Calls.length, 1)
    })

    it('a failure of the selector delete fails the uninstall too', async () =>
    {
        const fx = new Fixture()
        fx.Orchestrators.Kubectl.DeleteSelectorError = new KubectlError('forbidden')
        await assert.rejects(fx.Uninstaller.Uninstall(Fixture.Hive('h1', HiveBackend.Local, InfraMode.Attach)), AgentUninstallError)
    })

    it('a non-kubectl failure is not an uninstall failure: it propagates as is (a real server error)', async () =>
    {
        const fx = new Fixture()
        const boom = new Error('raw internal detail')
        fx.Orchestrators.ResolveError = boom
        const err = await fx.Uninstaller.Uninstall(Fixture.Hive('h1', HiveBackend.Local, InfraMode.Attach)).then(() => undefined, (e: unknown) => e)
        assert.equal(err, boom)
        fx.Orchestrators.ResolveError = undefined
        const typeError = new TypeError('bug')
        fx.Orchestrators.Kubectl.DeleteManifestError = typeError
        assert.equal(await fx.Uninstaller.Uninstall(Fixture.Hive('h1', HiveBackend.Local, InfraMode.Attach)).then(() => undefined, (e: unknown) => e), typeError)
    })

    it('refuses a (legacy) hive id that is not a valid label value: =b and "b " would select other hives', async () =>
    {
        for (const id of ['=b', 'b '])
        {
            const fx = new Fixture()
            const err = await fx.Uninstaller.Uninstall(Fixture.Hive(id, HiveBackend.Local, InfraMode.Attach)).then(() => undefined, (e: unknown) => e)
            assert.ok(err instanceof AgentUninstallError)
            assert.match(err.message, /not a valid Kubernetes label value/)
            assert.deepEqual(fx.Orchestrators.Kubectl.Calls, [])
            assert.deepEqual(fx.Orchestrators.Resolved, [])
        }
    })

    it('reports as retained only the tenant-admin data PVC and seed Secret that exist', async () =>
    {
        const fx = new Fixture()
        fx.Orchestrators.Kubectl.Objects.set('deployment/' + K8sManifestBuilder.TenantAdminNameOf('t1'), Fixture.Deployment('h1'))
        fx.Orchestrators.Kubectl.Objects.set('persistentvolumeclaim/' + K8sManifestBuilder.TenantAdminClaimNameOf('t1'), '{}')
        assert.deepEqual(await fx.Uninstaller.Uninstall(Fixture.Hive('h1', HiveBackend.Local, InfraMode.Attach)), [K8sManifestBuilder.TenantAdminClaimNameOf('t1')])
        fx.Orchestrators.Kubectl.Objects.set('secret/' + K8sManifestBuilder.TenantAdminSeedSecretNameOf('t1'), '{}')
        assert.deepEqual(await fx.Uninstaller.Uninstall(Fixture.Hive('h1', HiveBackend.Local, InfraMode.Attach)), [
            K8sManifestBuilder.TenantAdminClaimNameOf('t1'),
            K8sManifestBuilder.TenantAdminSeedSecretNameOf('t1'),
        ])
    })

    it('on a cluster below Kubernetes 1.30 the console removal leaves out the admission policy kinds (kubectl would refuse the whole delete)', async () =>
    {
        const fx = new Fixture()
        fx.Orchestrators.Kubectl.ServesAdmission = false
        await fx.Uninstaller.Uninstall(Fixture.Hive('h1', HiveBackend.Local, InfraMode.Attach))
        const deletes = fx.Orchestrators.Kubectl.Calls.filter(c => c[0] === 'DeleteManifest').map(c => c[1])
        assert.deepEqual(deletes, [HiveBootstrapBundle.RemovalManifest('h1'), new K8sManifestBuilder().TenantConsoleRemovalManifest('t1', 'h1', false)])
        assert.ok(fx.Orchestrators.Kubectl.Calls.some(c => c[0] === 'ServesResource' && c[1] === 'admissionregistration.k8s.io/v1' && c[2] === 'validatingadmissionpolicies'))
    })

    it('reports the in-hive IdP data volume and Secrets it keeps (its Deployment, Service and Ingress are removed with the console)', async () =>
    {
        const fx = new Fixture()
        const k = fx.Orchestrators.Kubectl
        k.Objects.set('persistentvolumeclaim/' + K8sManifestBuilder.IdpClaimNameOf('t1'), '{}')
        k.Objects.set('secret/' + InClusterIdpSeedSource.TlsSecretNameOf('t1'), '{}')
        k.Objects.set('secret/' + InClusterIdpSeedSource.AdminSecretNameOf('t1'), '{}')
        const retained = await fx.Uninstaller.Uninstall(Fixture.Hive('h1', HiveBackend.Local, InfraMode.Attach))
        assert.deepEqual(retained, [K8sManifestBuilder.IdpClaimNameOf('t1'), InClusterIdpSeedSource.TlsSecretNameOf('t1'), InClusterIdpSeedSource.AdminSecretNameOf('t1')])
        assert.ok(k.Calls.some(c => c[0] === 'Find' && c[1] === K8sManifestBuilder.IdpNameOf('t1') && c[2] === 'persistentvolumeclaim/' + K8sManifestBuilder.IdpClaimNameOf('t1')))
    })

    it('two hives of one tenant on one context: deleting the hive that does not own the tenant-admin leaves its credential copies and retains nothing', async () =>
    {
        const fx = new Fixture()
        fx.Orchestrators.Kubectl.Objects.set('deployment/' + K8sManifestBuilder.TenantAdminNameOf('t1'), Fixture.Deployment('owner'))
        fx.Orchestrators.Kubectl.Objects.set('persistentvolumeclaim/' + K8sManifestBuilder.TenantAdminClaimNameOf('t1'), '{}')
        fx.Orchestrators.Kubectl.Objects.set('secret/' + K8sManifestBuilder.TenantAdminSeedSecretNameOf('t1'), '{}')
        const retained = await fx.Uninstaller.Uninstall(Fixture.Hive('other', HiveBackend.Local, InfraMode.Attach))
        assert.deepEqual(retained, [])
        const calls = fx.Orchestrators.Kubectl.Calls
        assert.ok(!calls.some(c => c[0] === 'DeleteManifest' && c[1] === new K8sManifestBuilder().TenantConsoleRemovalManifest('t1', 'other')))
        assert.deepEqual(calls.find(c => c[0] === 'DeleteBySelector'), ['DeleteBySelector', 'pragmatic-system', 'deployment,service,serviceaccount,secret', 'pragmatic/hive=other'])
    })

    it('a tenant-admin Deployment without the hive label is not ours either: its credential copies stay', async () =>
    {
        const fx = new Fixture()
        fx.Orchestrators.Kubectl.Objects.set('deployment/' + K8sManifestBuilder.TenantAdminNameOf('t1'), '{"metadata":{"name":"x"}}')
        await fx.Uninstaller.Uninstall(Fixture.Hive('h1', HiveBackend.Local, InfraMode.Attach))
        assert.ok(!fx.Orchestrators.Kubectl.Calls.some(c => c[0] === 'DeleteManifest' && c[1] === new K8sManifestBuilder().TenantConsoleRemovalManifest('t1', 'h1')))
    })

    it('the console removal covers the cluster-scoped grants and admission fence a bootstrap install left, and every credential copy', async () =>
    {
        const fx = new Fixture()
        await fx.Uninstaller.Uninstall(Fixture.Hive('h1', HiveBackend.Local, InfraMode.Attach))
        const removal = fx.Orchestrators.Kubectl.Calls.filter(c => c[0] === 'DeleteManifest')[1]?.[1] ?? ''
        const kinds = (JSON.parse(removal) as { items: Array<{ kind: string; metadata: { name: string } }> }).items.map(i => i.kind + '/' + i.metadata.name)
        const name = K8sManifestBuilder.TenantAdminNameOf('t1')
        for (const expected of ['ClusterRole/' + name, 'ClusterRoleBinding/' + name, 'ValidatingAdmissionPolicy/' + name, 'ValidatingAdmissionPolicyBinding/' + name,
            'ClusterRole/' + K8sManifestBuilder.TenantConsoleEnvRoleNameOf('t1'), 'Ingress/' + name])
        {
            assert.ok(kinds.includes(expected), expected)
        }
        for (const secret of K8sManifestBuilder.TenantConsoleCredentialIdentitiesOf('t1') as Array<{ metadata: { name: string } }>)
        {
            assert.ok(kinds.includes('Secret/' + secret.metadata.name), secret.metadata.name)
        }
    })

    it('environment namespaces: deletes those labelled for the hive inside pragmatic-env-*, and reports the ones that failed', async () =>
    {
        const fx = new Fixture()
        fx.Orchestrators.Kubectl.FailedNamespaces = ['pragmatic-env-stuck']
        const failed = await fx.Uninstaller.DeleteEnvironmentNamespaces(Fixture.Hive('h1', HiveBackend.Local, InfraMode.Attach))
        assert.deepEqual(failed, ['pragmatic-env-stuck'])
        assert.deepEqual(fx.Orchestrators.Kubectl.Calls, [['DeleteNamespacesBySelector', 'pragmatic/hive=h1', 'pragmatic-env-']])
    })

    it('environment namespaces that cannot be listed are an AgentUninstallError; an unsafe id is refused before kubectl', async () =>
    {
        const fx = new Fixture()
        fx.Orchestrators.Kubectl.NamespaceListError = new KubectlError('forbidden')
        await assert.rejects(fx.Uninstaller.DeleteEnvironmentNamespaces(Fixture.Hive('h1', HiveBackend.Local, InfraMode.Attach)),
            (err: unknown) => err instanceof ConsoleUninstallError && err instanceof AgentUninstallError && /^Could not remove the hive's console \(or the environment namespaces it created\) from its cluster: /.test(err.message))
        await assert.rejects(fx.Uninstaller.DeleteEnvironmentNamespaces(Fixture.Hive('Bad_Id', HiveBackend.Local, InfraMode.Attach)), AgentUninstallError)
        assert.equal(fx.Orchestrators.Kubectl.Calls.length, 1)
    })
})
