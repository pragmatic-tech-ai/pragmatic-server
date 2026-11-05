import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EnvNamespaceGuard, EnvNamespaceRefusal, EnvNamespaceRefusedError } from '../env-namespace-guard.js'
import type { IKubectl } from '../kubectl.js'

class RecordingKubectl implements IKubectl
{
    public readonly Calls: string[][] = []

    private Record(method: string, args: string[]): Promise<void>
    {
        this.Calls.push([method, ...args])
        return Promise.resolve()
    }

    public Apply(m: string) { return this.Record('Apply', [m]) }
    public RolloutStatus(n: string, d: string) { return this.Record('RolloutStatus', [n, d]) }
    public SetImage(n: string, d: string, c: string, i: string) { return this.Record('SetImage', [n, d, c, i]) }
    public Scale(n: string, d: string, r: number) { return this.Record('Scale', [n, d, String(r)]) }
    public ScaleStatefulSet(n: string, d: string, r: number) { return this.Record('ScaleStatefulSet', [n, d, String(r)]) }
    public RolloutRestart(n: string, d: string) { return this.Record('RolloutRestart', [n, d]) }
    public RolloutRestartSelector(n: string, s: string) { return this.Record('RolloutRestartSelector', [n, s]) }
    public ApplyServerSide(m: string) { return this.Record('ApplyServerSide', [m]) }
    public DeleteManifest(m: string) { return this.Record('DeleteManifest', [m]) }
    public DeleteBySelector(n: string, r: string, s: string) { return this.Record('DeleteBySelector', [n, r, s]) }
    public async DeleteNamespacesBySelector(s: string, p: string): Promise<string[]> { await this.Record('DeleteNamespacesBySelector', [s, p]); return [] }
    public async ListNamespacesBySelector(s: string, p: string): Promise<string[]> { await this.Record('ListNamespacesBySelector', [s, p]); return [] }
    public DeleteNamespace(n: string) { return this.Record('DeleteNamespace', [n]) }
    public async Find(n: string, r: string): Promise<string | undefined> { await this.Record('Find', [n, r]); return undefined }
    public async Get(n: string, r: string): Promise<string> { await this.Record('Get', [n, r]); return '{}' }
}

class GuardFixture
{
    public static readonly Env = 'pragmatic-env-a'

    public static List(...items: object[]): string
    {
        return JSON.stringify({ apiVersion: 'v1', kind: 'List', items })
    }

    public static Secret(namespace: string): object
    {
        return { apiVersion: 'v1', kind: 'Secret', metadata: { name: 's', namespace } }
    }

    public static Namespace(name: string): object
    {
        return { apiVersion: 'v1', kind: 'Namespace', metadata: { name } }
    }

    public static Make(): { inner: RecordingKubectl; guard: EnvNamespaceGuard }
    {
        const inner = new RecordingKubectl()
        return { inner, guard: new EnvNamespaceGuard(inner) }
    }

    public static IsRefusal(e: unknown): boolean
    {
        return e instanceof EnvNamespaceRefusedError
    }
}

test('refuses a call outside pragmatic-env-*', async () =>
{
    const { inner, guard } = GuardFixture.Make()
    await assert.rejects(guard.Get('pragmatic-system', 'secret/x'), (e: unknown) =>
        GuardFixture.IsRefusal(e)
        && (e as Error).message === 'The tenant console manages only its own namespaces named pragmatic-env-*: pragmatic-system')
    assert.deepEqual(inner.Calls, [])
})

test('refuses every namespaced verb outside the prefix, and the bare prefix itself', async () =>
{
    const { inner, guard } = GuardFixture.Make()
    const outside = 'kube-system'
    const calls: Array<() => Promise<unknown>> = [
        () => guard.Find(outside, 'secret/x'),
        () => guard.RolloutStatus(outside, 'd'),
        () => guard.SetImage(outside, 'd', 'c', 'i'),
        () => guard.Scale(outside, 'd', 1),
        () => guard.ScaleStatefulSet(outside, 's', 1),
        () => guard.RolloutRestart(outside, 'd'),
        () => guard.RolloutRestartSelector(outside, 'a=b'),
        () => guard.DeleteBySelector(outside, 'secret', 'a=b'),
        () => guard.DeleteNamespace(outside),
        () => guard.DeleteNamespace('pragmatic-env-'),
    ]
    for (const call of calls)
    {
        await assert.rejects(call(), GuardFixture.IsRefusal)
    }
    assert.deepEqual(inner.Calls, [])
})

test('refuses a cluster-scoped object in a manifest', async () =>
{
    const { inner, guard } = GuardFixture.Make()
    const manifest = GuardFixture.List(
        GuardFixture.Secret(GuardFixture.Env),
        { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'cluster-admin-2' } })
    await assert.rejects(guard.Apply(manifest), GuardFixture.IsRefusal)
    await assert.rejects(guard.ApplyServerSide(manifest), GuardFixture.IsRefusal)
    await assert.rejects(guard.DeleteManifest(manifest), GuardFixture.IsRefusal)
    assert.deepEqual(inner.Calls, [])
})

test('refuses a manifest naming a foreign namespace, a foreign Namespace or an unknown kind', async () =>
{
    const { inner, guard } = GuardFixture.Make()
    await assert.rejects(guard.Apply(GuardFixture.List(GuardFixture.Secret('pragmatic-system'))), GuardFixture.IsRefusal)
    await assert.rejects(guard.Apply(GuardFixture.List(GuardFixture.Namespace('pragmatic-system'))), GuardFixture.IsRefusal)
    await assert.rejects(guard.Apply(JSON.stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 's' } })), GuardFixture.IsRefusal)
    await assert.rejects(guard.Apply(GuardFixture.List({ apiVersion: 'example.com/v1', kind: 'Widget', metadata: { name: 'w', namespace: GuardFixture.Env } })), GuardFixture.IsRefusal)
    assert.deepEqual(inner.Calls, [])
})

test('refuses a nested List item and a null item', async () =>
{
    const { inner, guard } = GuardFixture.Make()
    const nested = { apiVersion: 'v1', kind: 'List', items: [GuardFixture.Secret('pragmatic-system')] }
    await assert.rejects(guard.Apply(GuardFixture.List(GuardFixture.Secret(GuardFixture.Env), nested)), GuardFixture.IsRefusal)
    await assert.rejects(guard.Apply(JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [null] })), GuardFixture.IsRefusal)
    await assert.rejects(guard.ApplyServerSide(JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [GuardFixture.Secret(GuardFixture.Env), null] })), GuardFixture.IsRefusal)
    assert.deepEqual(inner.Calls, [])
})

test('a refused object is reported as the Target, not as a namespace', async () =>
{
    const { guard } = GuardFixture.Make()
    await assert.rejects(guard.Get(GuardFixture.Env, 'clusterrole/cluster-admin'), (e: unknown) =>
        e instanceof EnvNamespaceRefusedError && e.Target === 'clusterrole/cluster-admin' && e.Refusal === EnvNamespaceRefusal.OutsidePrefix)
    await assert.rejects(guard.Apply(GuardFixture.List({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'x' } })), (e: unknown) =>
        e instanceof EnvNamespaceRefusedError && e.Target === 'ClusterRole/x')
    await assert.rejects(guard.Scale('kube-system', 'd', 1), (e: unknown) =>
        e instanceof EnvNamespaceRefusedError && e.Target === 'kube-system')
})

test('refuses a cluster-scoped Get even when the namespace argument is an env namespace', async () =>
{
    const { inner, guard } = GuardFixture.Make()
    await assert.rejects(guard.Get(GuardFixture.Env, 'clusterrole/cluster-admin'), GuardFixture.IsRefusal)
    await assert.rejects(guard.Find(GuardFixture.Env, 'namespace/kube-system'), GuardFixture.IsRefusal)
    await assert.rejects(guard.DeleteBySelector(GuardFixture.Env, 'secret,clusterrole', 'a=b'), GuardFixture.IsRefusal)
    assert.deepEqual(inner.Calls, [])
})

test('passes env namespaces through', async () =>
{
    const { inner, guard } = GuardFixture.Make()
    const manifest = GuardFixture.List(GuardFixture.Namespace(GuardFixture.Env), GuardFixture.Secret(GuardFixture.Env))
    await guard.Apply(manifest)
    await guard.ApplyServerSide(JSON.stringify(GuardFixture.Secret(GuardFixture.Env)))
    await guard.Get(GuardFixture.Env, 'deployment/x')
    await guard.Find(GuardFixture.Env, `namespace/${GuardFixture.Env}`)
    await guard.DeleteNamespace(GuardFixture.Env)
    await guard.DeleteBySelector(GuardFixture.Env, 'deployment,secret', 'a=b')
    assert.deepEqual(inner.Calls.map(c => c[0]), ['Apply', 'ApplyServerSide', 'Get', 'Find', 'DeleteNamespace', 'DeleteBySelector'])
    assert.equal(inner.Calls[0][1], manifest)
})

test('a namespace sweep passes only an env prefix through', async () =>
{
    const { inner, guard } = GuardFixture.Make()
    await assert.rejects(guard.DeleteNamespacesBySelector('pragmatic/hive=h1', 'kube-'), GuardFixture.IsRefusal)
    await assert.rejects(guard.DeleteNamespacesBySelector('pragmatic/hive=h1', ''), GuardFixture.IsRefusal)
    assert.deepEqual(inner.Calls, [])
    await guard.DeleteNamespacesBySelector('pragmatic/hive=h1', 'pragmatic-env-')
    assert.deepEqual(inner.Calls, [['DeleteNamespacesBySelector', 'pragmatic/hive=h1', 'pragmatic-env-']])
})

test('a namespace listing passes only an env prefix through', async () =>
{
    const { inner, guard } = GuardFixture.Make()
    await assert.rejects(guard.ListNamespacesBySelector('pragmatic/hive=h1', 'kube-'), GuardFixture.IsRefusal)
    assert.deepEqual(inner.Calls, [])
    await guard.ListNamespacesBySelector('pragmatic/hive=h1', 'pragmatic-env-')
    assert.deepEqual(inner.Calls, [['ListNamespacesBySelector', 'pragmatic/hive=h1', 'pragmatic-env-']])
})

test('a malformed manifest fails without echoing its content', async () =>
{
    const { inner, guard } = GuardFixture.Make()
    await assert.rejects(guard.Apply('{"data":{"tls.key":"c2VjcmV0'), (e: unknown) => e instanceof Error && !(e as Error).message.includes('c2VjcmV0'))
    assert.deepEqual(inner.Calls, [])
})

test('AssertHiveOwns accepts an absent or own namespace and refuses a foreign or unlabelled one', () =>
{
    EnvNamespaceGuard.AssertHiveOwns(undefined, GuardFixture.Env, 'h1')
    EnvNamespaceGuard.AssertHiveOwns({ metadata: { labels: { 'pragmatic/hive': 'h1' } } }, GuardFixture.Env, 'h1')
    assert.throws(() => EnvNamespaceGuard.AssertHiveOwns({ metadata: { labels: { 'pragmatic/hive': 'other' } } }, GuardFixture.Env, 'h1'), GuardFixture.IsRefusal)
    assert.throws(() => EnvNamespaceGuard.AssertHiveOwns({ metadata: {} }, GuardFixture.Env, 'h1'), (e: unknown) =>
        GuardFixture.IsRefusal(e) && (e as Error).message.includes(GuardFixture.Env))
})
