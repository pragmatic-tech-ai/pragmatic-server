import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AgentUninstallError, HiveAgentUninstaller } from '../hive-agent-uninstaller.js'
import { HiveBootstrapBundle } from '../hive-bootstrap-bundle.js'
import { K8sManifestBuilder } from '../k8s-manifest-builder.js'
import { TenantAdminBootstrap } from '../tenant-admin-bootstrap.js'
import type { IHiveOrchestrator, WorkloadHealth } from '../hive-orchestrator.js'
import { KubectlError, type IKubectl } from '../kubectl.js'
import type { EnvironmentWorkload } from '../environment-workload.js'
import { HiveBackend, InfraMode, type HiveRecord } from '../platform-records.js'

class FakeKubectl implements IKubectl
{
    public readonly Calls: string[][] = []
    public DeleteManifestError: Error | undefined
    public DeleteSelectorError: Error | undefined

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

    it('deletes the bundle objects, the token Secret and the tenant-admin credential Secrets by name, then the hive-labelled stateless objects', async () =>
    {
        const fx = new Fixture()
        await fx.Uninstaller.Uninstall(Fixture.Hive('h1', HiveBackend.Local, InfraMode.Attach))
        assert.deepEqual(fx.Orchestrators.Resolved, ['h1'])
        assert.deepEqual(fx.Orchestrators.Kubectl.Calls, [
            ['DeleteManifest', HiveBootstrapBundle.RemovalManifest('h1')],
            ['DeleteManifest', TenantAdminBootstrap.CredentialRemovalManifest('t1')],
            ['DeleteBySelector', 'pragmatic-system', 'deployment,service,serviceaccount,secret', 'pragmatic/hive=h1'],
        ])
        // The tenant-admin data PVC and its seed Secret (the master key that decrypts it) are kept together.
        const all = JSON.stringify(fx.Orchestrators.Kubectl.Calls)
        assert.ok(!all.includes(K8sManifestBuilder.TenantAdminClaimNameOf('t1')))
        assert.ok(!all.includes(K8sManifestBuilder.TenantAdminSeedSecretNameOf('t1')))
        assert.ok(!all.includes('persistentvolumeclaim'))
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

    it('Retained names the tenant-admin data PVC and its seed Secret, kept together', () =>
    {
        const fx = new Fixture()
        assert.deepEqual(fx.Uninstaller.Retained(Fixture.Hive('h1', HiveBackend.Local, InfraMode.Attach)), [
            K8sManifestBuilder.TenantAdminClaimNameOf('t1'),
            K8sManifestBuilder.TenantAdminSeedSecretNameOf('t1'),
        ])
    })
})
