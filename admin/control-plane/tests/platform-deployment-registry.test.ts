import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import { ManifestRegistry } from '../manifest-record.js'
import { GatingRegistry } from '../gating-record.js'
import { SelectionRegistry } from '../selection-record.js'
import { RolloutReportRegistry } from '../rollout-report-record.js'
import { RolloutRegistrationRegistry } from '../rollout-registration-record.js'
import { AgentUnauthorizedError, HiveNotRegisteredError, ManifestExistsError, ManifestNotGatedError, UnknownHiveError, UnknownManifestError } from '../rollout-errors.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import type { HiveRecord } from '../platform-records.js'

class Fx
{
    public static readonly Prefix = 'deploy-reg-'
    public static readonly TenantA = 'tenant-a'
    public static readonly TenantB = 'tenant-b'
    public static readonly HiveA = 'hive-a'
    public static readonly V1 = '1.0.0'
    public static readonly V2 = '2.0.0'
    public static readonly Env = 'prod'
    public static readonly Wrong = 'not-the-token'
    public static readonly TokenRef = 'secret://x'
    public static readonly Suffix = '-x'
    public static readonly NoHive = 'no-such-hive'
    public static readonly GarbageLength = 100000
    public static readonly GarbageChar = 'x'

    public static Image(version: string): string
    {
        return 'registry/pragmatic-server:' + version
    }

    public static Hive(id: string, tenantId: string): HiveRecord
    {
        return { id, tenantId, displayName: id, cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Attach }, agentTokenRef: Fx.TokenRef, createdAt: '2026-10-22T00:00:00.000Z' }
    }

    public static async Run(body: (reg: PlatformDeploymentRegistry, registrations: RolloutRegistrationRegistry) => Promise<void>): Promise<void>
    {
        const dir = await mkdtemp(join(tmpdir(), Fx.Prefix))
        try
        {
            const registrations = new RolloutRegistrationRegistry(join(dir, 'x.json'))
            const hives = new Map([[Fx.HiveA, Fx.Hive(Fx.HiveA, Fx.TenantA)]])
            const reg = new PlatformDeploymentRegistry(new ManifestRegistry(join(dir, 'm.json')), new GatingRegistry(join(dir, 'g.json')), new SelectionRegistry(join(dir, 's.json')), new RolloutReportRegistry(join(dir, 'r.json')), registrations, { GetHive: id => hives.get(id) })
            await body(reg, registrations)
        }
        finally
        {
            await rm(dir, { recursive: true, force: true })
        }
    }

    public static async PublishGated(reg: PlatformDeploymentRegistry, versions: string[]): Promise<void>
    {
        for (const v of versions)
        {
            await reg.Publish(v, Fx.Image(v))
            await reg.Gate(Fx.TenantA, v)
        }
    }
}

test('Publish then ManifestsFor only after Gate; Ungate removes; duplicate rejected', async () =>
{
    await Fx.Run(async reg =>
    {
        await reg.Publish(Fx.V1, Fx.Image(Fx.V1))
        assert.equal(reg.ManifestsFor(Fx.TenantA).length, 0)
        await reg.Gate(Fx.TenantA, Fx.V1)
        assert.deepEqual(reg.ManifestsFor(Fx.TenantA).map(m => m.id), [Fx.V1])
        assert.equal(reg.ManifestsFor(Fx.TenantB).length, 0)
        await reg.Ungate(Fx.TenantA, Fx.V1)
        assert.equal(reg.ManifestsFor(Fx.TenantA).length, 0)
        await assert.rejects(reg.Publish(Fx.V1, Fx.Image(Fx.V1)), ManifestExistsError)
    })
})

test('SelectTarget validates published and gated for the hive tenant', async () =>
{
    await Fx.Run(async reg =>
    {
        await assert.rejects(reg.SelectTarget(Fx.HiveA, Fx.V1), UnknownManifestError)
        await reg.Publish(Fx.V1, Fx.Image(Fx.V1))
        await reg.Gate(Fx.TenantB, Fx.V1)
        await assert.rejects(reg.SelectTarget(Fx.HiveA, Fx.V1), ManifestNotGatedError)
        assert.equal(reg.ManifestsFor(Fx.TenantA).length, 0)
        assert.equal(reg.TargetFor(Fx.HiveA), undefined)
        await reg.Gate(Fx.TenantA, Fx.V1)
        await reg.SelectTarget(Fx.HiveA, Fx.V1)
        assert.deepEqual(reg.TargetFor(Fx.HiveA), { version: Fx.V1, image: Fx.Image(Fx.V1) })
    })
})

test('obsoletion is strict image equality and clears on match', async () =>
{
    await Fx.Run(async reg =>
    {
        await Fx.PublishGated(reg, [Fx.V1, Fx.V2])
        await reg.SelectTarget(Fx.HiveA, Fx.V2)
        await reg.Report(Fx.HiveA, Fx.Env, Fx.Image(Fx.V1), true)
        assert.equal(reg.StatusFor(Fx.HiveA).targetVersion, Fx.V2)
        assert.equal(reg.StatusFor(Fx.HiveA).environments[0].obsolete, true)
        await reg.Report(Fx.HiveA, Fx.Env, Fx.Image(Fx.V2), true)
        assert.equal(reg.StatusFor(Fx.HiveA).environments[0].obsolete, false)
        await reg.Report(Fx.HiveA, Fx.Env, Fx.Image(Fx.V2).slice(0, -1), true)
        assert.equal(reg.StatusFor(Fx.HiveA).environments[0].obsolete, true)
        await reg.Report(Fx.HiveA, Fx.Env, Fx.Image(Fx.V2) + Fx.Suffix, true)
        assert.equal(reg.StatusFor(Fx.HiveA).environments[0].obsolete, true)
        assert.equal(reg.StatusFor(Fx.HiveA).environments.length, 1)
    })
})

test('rollback re-selects an older version', async () =>
{
    await Fx.Run(async reg =>
    {
        await Fx.PublishGated(reg, [Fx.V1, Fx.V2])
        await reg.SelectTarget(Fx.HiveA, Fx.V2)
        await reg.SelectTarget(Fx.HiveA, Fx.V1)
        assert.equal(reg.TargetFor(Fx.HiveA)?.image, Fx.Image(Fx.V1))
    })
})

test('machine token is hashed, verified, and never leaked in errors', async () =>
{
    await Fx.Run(async (reg, registrations) =>
    {
        await assert.rejects(reg.VerifyAgentToken(Fx.HiveA, Fx.Wrong), HiveNotRegisteredError)
        const token = await reg.RegisterHive(Fx.HiveA)
        assert.ok(token.length > 0)
        const stored = registrations.Get(Fx.HiveA)!
        assert.notEqual(stored.agentTokenHash, token)
        await reg.VerifyAgentToken(Fx.HiveA, token)
        const err = await reg.VerifyAgentToken(Fx.HiveA, Fx.Wrong).then(() => undefined, (e: Error) => e)
        assert.ok(err instanceof AgentUnauthorizedError)
        assert.ok(!err.message.includes(token) && !err.message.includes(stored.agentTokenHash) && !err.message.includes(Fx.Wrong))
    })
})

test('SelectTarget on an unknown hive throws UnknownHiveError', async () =>
{
    await Fx.Run(async reg =>
    {
        await reg.Publish(Fx.V1, Fx.Image(Fx.V1))
        await assert.rejects(reg.SelectTarget(Fx.NoHive, Fx.V1), UnknownHiveError)
    })
})

test('VerifyAgentToken rejects empty and garbage tokens without leaking', async () =>
{
    await Fx.Run(async (reg, registrations) =>
    {
        await reg.RegisterHive(Fx.HiveA)
        const stored = registrations.Get(Fx.HiveA)!.agentTokenHash
        for (const presented of ['', Fx.GarbageChar.repeat(Fx.GarbageLength)])
        {
            const err = await reg.VerifyAgentToken(Fx.HiveA, presented).then(() => undefined, (e: Error) => e)
            assert.ok(err instanceof AgentUnauthorizedError)
            assert.ok(!err.message.includes(stored))
            assert.ok(presented === '' || !err.message.includes(presented))
        }
    })
})
