import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import { ManifestRegistry } from '../manifest-record.js'
import { GatingRegistry } from '../gating-record.js'
import { SelectionRegistry } from '../selection-record.js'
import { RolloutRegistrationRegistry } from '../rollout-registration-record.js'
import { AgentUnauthorizedError, HiveNotRegisteredError, ManifestExistsError, ManifestNotGatedError, PolicyStoreUnavailableError, UnknownHiveError, UnknownManifestError } from '../rollout-errors.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import type { HiveRecord } from '../platform-records.js'
import { UnsupportedBackendError } from '../hive-orchestrator.js'
import type { IHiveOrchestrator } from '../hive-orchestrator.js'
import type { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import type { EnvironmentRecord } from '../environment-record.js'
import type { EnvironmentWorkload } from '../environment-workload.js'
import type { HiveHealthDto } from '../hive-health-producer.js'
import { RolloutFixture } from './rollout-fixture.js'
import { AdoptionLedgerRegistry } from '../adoption-ledger-record.js'
import { Channel } from '../channel.js'
import { ReleasePolicyRegistry } from '../release-policy-record.js'
import { ManifestWithdrawnError, TenantOnHoldError, ChannelNotSubscribedError, VersionBelowFloorError } from '../rollout-errors.js'
import type { PlatformDirectory } from '../platform-directory.js'
import type { IManifestSigner } from '../manifest-signer.js'

class ThrowingLedger extends AdoptionLedgerRegistry
{
    public override async Append(): Promise<void>
    {
        throw new Error('ledger down')
    }
}

class Fx
{
    public static readonly Prefix = 'deploy-reg-'
    public static readonly TenantA = 'tenant-a'
    public static readonly TenantB = 'tenant-b'
    public static readonly HiveA = 'hive-a'
    public static readonly V1 = '1.0.0'
    public static readonly V2 = '2.0.0'
    public static readonly V3 = '3.0.0'
    public static readonly Env = 'prod'
    public static readonly Wrong = 'not-the-token'
    public static readonly TokenRef = 'secret://x'
    public static readonly Suffix = '-x'
    public static readonly NoHive = 'no-such-hive'
    public static readonly GarbageLength = 100000
    public static readonly GarbageChar = 'x'
    public static readonly Digest = 'sha256:abc'
    public static readonly BadBuild = 'bad build'
    public static readonly Operator = 'op@x'
    public static readonly LegacyAt = '2026-01-01T00:00:00.000Z'

    public static Signer(digest: string | undefined, signed: boolean): IManifestSigner
    {
        return { SignForPublish: async () => (digest === undefined ? { signed } : { digest, signed }) }
    }

    public static Image(version: string): string
    {
        return 'registry/pragmatic-server:' + version
    }

    public static Health(name: string, image: string | undefined, ready: boolean): HiveHealthDto
    {
        return { environmentName: name, ready, runningImage: image, detail: Fx.NoDetail }
    }

    public static readonly HiveB = 'hive-b'
    public static readonly NoDetail = ''
    public static readonly EnvNames = ['e1', 'e2', 'e3']

    public static EnvRecord(name: string, hiveId: string): EnvironmentRecord
    {
        return { name, hiveId, tenantId: Fx.TenantA } as unknown as EnvironmentRecord
    }

    public static Hive(id: string, tenantId: string): HiveRecord
    {
        return { id, tenantId, displayName: id, cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Attach }, agentTokenRef: Fx.TokenRef, createdAt: '2026-10-22T00:00:00.000Z' }
    }

    public static async Run(body: (reg: PlatformDeploymentRegistry, registrations: RolloutRegistrationRegistry, rolls: string[], ledger: AdoptionLedgerRegistry) => Promise<void>, unreachable: boolean = false, signer?: IManifestSigner, withPolicies: boolean = true, ledgerOverride?: AdoptionLedgerRegistry): Promise<void>
    {
        const dir = await mkdtemp(join(tmpdir(), Fx.Prefix))
        try
        {
            const registrations = new RolloutRegistrationRegistry(join(dir, 'x.json'))
            const hives = new Map([[Fx.HiveA, Fx.Hive(Fx.HiveA, Fx.TenantA)]])
            const rolls: string[] = []
            const orchestrator: IHiveOrchestrator = { Roll: async (w: EnvironmentWorkload, image: string) => { rolls.push((w as unknown as { name: string }).name + '@' + image) } } as unknown as IHiveOrchestrator
            const factory = { For: () => { if (unreachable) { throw new UnsupportedBackendError(HiveBackend.Aks, InfraMode.Attach) } return orchestrator } } as unknown as HiveOrchestratorFactory
            const envs = [Fx.EnvRecord(Fx.EnvNames[0], Fx.HiveA), Fx.EnvRecord(Fx.EnvNames[1], Fx.HiveA), Fx.EnvRecord(Fx.EnvNames[2], Fx.HiveB)]
            const policies = new ReleasePolicyRegistry(join(dir, 'p.json'))
            await policies.Load()
            const ledger = ledgerOverride ?? RolloutFixture.Ledger(dir)
            await ledger.Load().catch(() => undefined)
            const reg = new PlatformDeploymentRegistry(new ManifestRegistry(join(dir, 'm.json')), new GatingRegistry(join(dir, 'g.json')), new SelectionRegistry(join(dir, 's.json')), registrations, { GetHive: id => hives.get(id) }, factory, { List: () => envs }, { WorkloadFor: e => e as unknown as EnvironmentWorkload }, RolloutFixture.Observations(dir), signer, withPolicies ? policies : undefined, ledger)
            await body(reg, registrations, rolls, ledger)
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

test('SetWithdrawn flags and restores a published version, surfacing on the gated tenant listing', async () =>
{
    await Fx.Run(async reg =>
    {
        await reg.Publish(Fx.V1, Fx.Image(Fx.V1))
        await reg.Gate(Fx.TenantA, Fx.V1)
        assert.equal(reg.ManifestsFor(Fx.TenantA)[0]!.withdrawn, undefined)
        const withdrawn = await reg.SetWithdrawn(Fx.V1, true)
        assert.equal(withdrawn.withdrawn, true)
        assert.equal(reg.ManifestsFor(Fx.TenantA)[0]!.withdrawn, true)
        const restored = await reg.SetWithdrawn(Fx.V1, false)
        assert.equal(restored.withdrawn, false)
        assert.equal(reg.ManifestsFor(Fx.TenantA)[0]!.withdrawn, false)
    })
})

test('AllManifests lists every published version including withdrawn ones, and is empty when none', async () =>
{
    await Fx.Run(async reg =>
    {
        assert.deepEqual(reg.AllManifests(), [])
        await reg.Publish(Fx.V1, Fx.Image(Fx.V1))
        await reg.Publish(Fx.V2, Fx.Image(Fx.V2))
        await reg.SetWithdrawn(Fx.V2, true)
        const all = reg.AllManifests()
        assert.deepEqual(all.map(m => m.id).sort(), [Fx.V1, Fx.V2])
        assert.equal(all.find(m => m.id === Fx.V2)!.withdrawn, true)
        assert.notEqual(all.find(m => m.id === Fx.V1)!.withdrawn, true)
    })
})

test('SetWithdrawn on an unknown version throws UnknownManifestError', async () =>
{
    await Fx.Run(async reg =>
    {
        await assert.rejects(reg.SetWithdrawn(Fx.V1, true), UnknownManifestError)
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

test('AllGating lists every gate across tenants, and is empty when fresh', async () =>
{
    await Fx.Run(async reg =>
    {
        assert.deepEqual(reg.AllGating(), [])
        await reg.Publish(Fx.V1, Fx.Image(Fx.V1))
        await reg.Publish(Fx.V2, Fx.Image(Fx.V2))
        await reg.Gate(Fx.TenantA, Fx.V1)
        await reg.Gate(Fx.TenantA, Fx.V2)
        const all = reg.AllGating()
        assert.equal(all.length, 2)
        assert.deepEqual(all.map(g => g.version).sort(), [Fx.V1, Fx.V2])
        assert.ok(all.every(g => g.tenantId === Fx.TenantA))
    })
})

test('AllSelections lists one record per hive with the latest target, and is empty when fresh', async () =>
{
    await Fx.Run(async reg =>
    {
        assert.deepEqual(reg.AllSelections(), [])
        await Fx.PublishGated(reg, [Fx.V1, Fx.V2])
        await reg.SelectTarget(Fx.HiveA, Fx.V1)
        await reg.SelectTarget(Fx.HiveA, Fx.V2)
        const all = reg.AllSelections()
        assert.equal(all.length, 1)
        assert.equal(all[0].hiveId, Fx.HiveA)
        assert.equal(all[0].targetVersion, Fx.V2)
    })
})

test('obsoletion is strict image equality and clears on match', async () =>
{
    await Fx.Run(async reg =>
    {
        await Fx.PublishGated(reg, [Fx.V1, Fx.V2])
        await reg.SelectTarget(Fx.HiveA, Fx.V2)
        await reg.ReportSnapshot(Fx.HiveA, [Fx.Health(Fx.Env, Fx.Image(Fx.V1), true)])
        assert.equal(reg.StatusFor(Fx.HiveA).targetVersion, Fx.V2)
        assert.equal(reg.StatusFor(Fx.HiveA).environments[0].obsolete, true)
        await reg.ReportSnapshot(Fx.HiveA, [Fx.Health(Fx.Env, Fx.Image(Fx.V2), true)])
        assert.equal(reg.StatusFor(Fx.HiveA).environments[0].obsolete, false)
        await reg.ReportSnapshot(Fx.HiveA, [Fx.Health(Fx.Env, Fx.Image(Fx.V2).slice(0, -1), true)])
        assert.equal(reg.StatusFor(Fx.HiveA).environments[0].obsolete, true)
        await reg.ReportSnapshot(Fx.HiveA, [Fx.Health(Fx.Env, Fx.Image(Fx.V2) + Fx.Suffix, true)])
        assert.equal(reg.StatusFor(Fx.HiveA).environments[0].obsolete, true)
        assert.equal(reg.StatusFor(Fx.HiveA).environments.length, 1)
    })
})

test('ReportSnapshot is reflected by StatusFor, obsolete computed against the target; undefined image is obsolete', async () =>
{
    await Fx.Run(async reg =>
    {
        await Fx.PublishGated(reg, [Fx.V2])
        await reg.SelectTarget(Fx.HiveA, Fx.V2)
        await reg.ReportSnapshot(Fx.HiveA, [Fx.Health(Fx.EnvNames[0], Fx.Image(Fx.V2), true), Fx.Health(Fx.EnvNames[1], undefined, false)])
        assert.deepEqual(reg.StatusFor(Fx.HiveA).environments, [
            { environmentName: Fx.EnvNames[0], runningImage: Fx.Image(Fx.V2), obsolete: false, ready: true },
            { environmentName: Fx.EnvNames[1], runningImage: undefined, obsolete: true, ready: false }
        ])
    })
})

test('StatusFor reports obsolete=false for a reported environment when no target is set', async () =>
{
    await Fx.Run(async reg =>
    {
        await reg.ReportSnapshot(Fx.HiveA, [Fx.Health(Fx.EnvNames[0], Fx.Image(Fx.V1), true)])
        const status = reg.StatusFor(Fx.HiveA)
        assert.equal(status.targetVersion, undefined)
        assert.deepEqual(status.environments, [{ environmentName: Fx.EnvNames[0], runningImage: Fx.Image(Fx.V1), obsolete: false, ready: true }])
    })
})

test('replacing the snapshot with a shorter list drops the removed environment from StatusFor', async () =>
{
    await Fx.Run(async reg =>
    {
        await reg.ReportSnapshot(Fx.HiveA, [Fx.Health(Fx.EnvNames[0], Fx.Image(Fx.V1), true), Fx.Health(Fx.EnvNames[1], Fx.Image(Fx.V1), true)])
        assert.deepEqual(reg.StatusFor(Fx.HiveA).environments.map(e => e.environmentName), [Fx.EnvNames[0], Fx.EnvNames[1]])
        await reg.ReportSnapshot(Fx.HiveA, [Fx.Health(Fx.EnvNames[0], Fx.Image(Fx.V1), true)])
        assert.deepEqual(reg.StatusFor(Fx.HiveA).environments.map(e => e.environmentName), [Fx.EnvNames[0]])
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

test('DeregisterHive removes a prior registration so VerifyAgentToken then fails', async () =>
{
    await Fx.Run(async reg =>
    {
        const token = await reg.RegisterHive(Fx.HiveA)
        await reg.VerifyAgentToken(Fx.HiveA, token)
        await reg.DeregisterHive(Fx.HiveA)
        await assert.rejects(reg.VerifyAgentToken(Fx.HiveA, token), HiveNotRegisteredError)
        await assert.doesNotReject(reg.DeregisterHive(Fx.NoHive))
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

test('SelectTarget rolls exactly the hive-bound environments with the manifest image', async () =>
{
    await Fx.Run(async (reg, _registrations, rolls) =>
    {
        await Fx.PublishGated(reg, [Fx.V2])
        await reg.SelectTarget(Fx.HiveA, Fx.V2)
        assert.deepEqual(rolls, [Fx.EnvNames[0] + '@' + Fx.Image(Fx.V2), Fx.EnvNames[1] + '@' + Fx.Image(Fx.V2)])
    })
})

test('SelectTarget on an unreachable backend records the selection and does not throw', async () =>
{
    await Fx.Run(async (reg, _registrations, rolls) =>
    {
        await Fx.PublishGated(reg, [Fx.V2])
        await reg.SelectTarget(Fx.HiveA, Fx.V2)
        assert.equal(reg.TargetFor(Fx.HiveA)?.version, Fx.V2)
        assert.equal(rolls.length, 0)
    }, true)
})

test('RecordAdoption records a gated version and does not push', async () =>
{
    await Fx.Run(async (reg, _registrations, rolls) =>
    {
        await Fx.PublishGated(reg, [Fx.V2])
        await reg.RecordAdoption(Fx.HiveA, Fx.V2)
        assert.deepEqual(reg.TargetFor(Fx.HiveA), { version: Fx.V2, image: Fx.Image(Fx.V2) })
        assert.equal(reg.StatusFor(Fx.HiveA).targetVersion, Fx.V2)
        assert.equal(rolls.length, 0)
    })
})

test('RecordAdoption applies the same gating as SelectTarget and writes nothing on refusal', async () =>
{
    await Fx.Run(async (reg, _registrations, rolls) =>
    {
        await assert.rejects(reg.RecordAdoption(Fx.HiveA, Fx.V1), UnknownManifestError)
        await reg.Publish(Fx.V1, Fx.Image(Fx.V1))
        await reg.Gate(Fx.TenantB, Fx.V1)
        await assert.rejects(reg.RecordAdoption(Fx.HiveA, Fx.V1), ManifestNotGatedError)
        await assert.rejects(reg.RecordAdoption(Fx.NoHive, Fx.V1), UnknownHiveError)
        assert.equal(reg.TargetFor(Fx.HiveA), undefined)
        assert.equal(rolls.length, 0)
    })
})

test('AdoptableFor lists the versions gated for the hive tenant and rejects an unknown hive', async () =>
{
    await Fx.Run(async reg =>
    {
        await Fx.PublishGated(reg, [Fx.V1, Fx.V2])
        await reg.Publish(Fx.V3, Fx.Image(Fx.V3))
        await reg.Gate(Fx.TenantB, Fx.V3)
        assert.deepEqual(reg.AdoptableFor(Fx.HiveA).map(m => m.id), [Fx.V1, Fx.V2])
        assert.throws(() => reg.AdoptableFor(Fx.NoHive), UnknownHiveError)
    })
})

test('publish records the channel, defaulting to stable', async () =>
{
    await Fx.Run(async reg =>
    {
        const a = await reg.Publish(Fx.V1, Fx.Image(Fx.V1))
        assert.equal(a.channel, Channel.Stable)
        const b = await reg.Publish(Fx.V2, Fx.Image(Fx.V2), undefined, Channel.EarlyAccess)
        assert.equal(b.channel, Channel.EarlyAccess)
        assert.equal(reg.AllManifests().find(m => m.id === Fx.V2)!.channel, Channel.EarlyAccess)
    })
})

test('publish records digest and signed from the signer', async () =>
{
    await Fx.Run(async reg =>
    {
        const m = await reg.Publish(Fx.V1, Fx.Image(Fx.V1))
        assert.equal(m.digest, Fx.Digest)
        assert.equal(m.signed, true)
    }, false, Fx.Signer(Fx.Digest, true))
})

test('publish without a signer records channel only', async () =>
{
    await Fx.Run(async reg =>
    {
        const m = await reg.Publish(Fx.V1, Fx.Image(Fx.V1))
        assert.equal(m.channel, Channel.Stable)
        assert.equal(m.digest, undefined)
        assert.ok(!m.signed)
    })
})

test('publish succeeds and records unsigned when the signer cannot sign', async () =>
{
    await Fx.Run(async reg =>
    {
        const m = await reg.Publish(Fx.V1, Fx.Image(Fx.V1))
        assert.equal(m.signed, false)
        assert.equal(m.digest, undefined)
        assert.ok(!('digest' in m))
        assert.equal(reg.AllManifests().length, 1)
    }, false, Fx.Signer(undefined, false))
})

test('withdraw records reason, actor and timestamp and sets the boolean; restore clears both', async () =>
{
    await Fx.Run(async reg =>
    {
        await reg.Publish(Fx.V1, Fx.Image(Fx.V1))
        const w = await reg.SetWithdrawn(Fx.V1, true, Fx.BadBuild, Fx.Operator)
        assert.equal(w.withdrawn, true)
        assert.equal(w.withdrawal!.reason, Fx.BadBuild)
        assert.equal(w.withdrawal!.actor, Fx.Operator)
        assert.ok(!Number.isNaN(Date.parse(w.withdrawal!.at)))
        const r = await reg.SetWithdrawn(Fx.V1, false)
        assert.equal(r.withdrawn, false)
        assert.equal(r.withdrawal, undefined)
        assert.ok(!('withdrawal' in r))
        assert.ok(!('withdrawal' in reg.AllManifests()[0]!))
    })
})

test('an old record with no new fields still loads and withdraws', async () =>
{
    await Fx.Run(async reg =>
    {
        const manifests = (reg as unknown as { manifests: ManifestRegistry }).manifests
        await manifests.Put({ id: Fx.V1, image: Fx.Image(Fx.V1), publishedAt: Fx.LegacyAt })
        const w = await reg.SetWithdrawn(Fx.V1, true, Fx.BadBuild, Fx.Operator)
        assert.equal(w.withdrawn, true)
        assert.equal(w.channel, undefined)
        assert.equal(w.withdrawal!.actor, Fx.Operator)
    })
})

class PolicyFx
{
    public static readonly Prefix = 'policy-reg-'
    public static readonly Tenant = 'tenant-p'
    public static readonly Floor = '1.2.0'
    public static readonly Reason = 'freeze'
    public static readonly Actor = 'op@x'

    public static async Run(body: (reg: PlatformDeploymentRegistry) => Promise<void>): Promise<void>
    {
        const dir = await mkdtemp(join(tmpdir(), PolicyFx.Prefix))
        try
        {
            const directory = { GetHive: () => undefined, List: () => [] } as unknown as PlatformDirectory
            const factory = {} as unknown as HiveOrchestratorFactory
            await body(await RolloutFixture.Create(dir, directory, factory))
        }
        finally
        {
            await rm(dir, { recursive: true, force: true })
        }
    }
}

test('without a policy store AllPolicies is empty and every mutation rejects', async () =>
{
    await Fx.Run(async reg =>
    {
        assert.deepEqual(reg.AllPolicies(), [])
        await assert.rejects(reg.SetChannels(PolicyFx.Tenant, [Channel.Stable]), PolicyStoreUnavailableError)
        await assert.rejects(reg.SetMinVersion(PolicyFx.Tenant, PolicyFx.Floor), PolicyStoreUnavailableError)
        await assert.rejects(reg.ClearMinVersion(PolicyFx.Tenant), PolicyStoreUnavailableError)
        await assert.rejects(reg.SetHold(PolicyFx.Tenant, PolicyFx.Reason, PolicyFx.Actor), PolicyStoreUnavailableError)
        await assert.rejects(reg.ClearHold(PolicyFx.Tenant), PolicyStoreUnavailableError)
    }, false, undefined, false)
})

test('SetChannels is reflected by AllPolicies', async () =>
{
    await PolicyFx.Run(async reg =>
    {
        const r = await reg.SetChannels(PolicyFx.Tenant, [Channel.Stable])
        assert.equal(r.id, PolicyFx.Tenant)
        assert.equal(r.tenantId, PolicyFx.Tenant)
        assert.deepEqual(reg.AllPolicies().map(p => p.channels), [[Channel.Stable]])
    })
})

test('SetMinVersion and SetHold merge into one record', async () =>
{
    await PolicyFx.Run(async reg =>
    {
        await reg.SetMinVersion(PolicyFx.Tenant, PolicyFx.Floor)
        const r = await reg.SetHold(PolicyFx.Tenant, PolicyFx.Reason, PolicyFx.Actor)
        assert.equal(r.id, PolicyFx.Tenant)
        assert.equal(r.minVersion, PolicyFx.Floor)
        assert.equal(r.hold!.reason, PolicyFx.Reason)
        assert.equal(r.hold!.actor, PolicyFx.Actor)
        assert.equal(reg.AllPolicies().length, 1)
    })
})

test('ClearMinVersion removes only minVersion; ClearHold removes only hold', async () =>
{
    await PolicyFx.Run(async reg =>
    {
        await reg.SetMinVersion(PolicyFx.Tenant, PolicyFx.Floor)
        await reg.SetHold(PolicyFx.Tenant, PolicyFx.Reason, PolicyFx.Actor)
        const a = await reg.ClearMinVersion(PolicyFx.Tenant)
        assert.ok(!('minVersion' in a))
        assert.equal(a.id, PolicyFx.Tenant)
        assert.equal(a.hold!.reason, PolicyFx.Reason)
        const b = await reg.ClearHold(PolicyFx.Tenant)
        assert.ok(!('hold' in b))
        assert.ok(!('minVersion' in b))
        assert.equal(b.id, PolicyFx.Tenant)
    })
})

class EnforceFx
{
    public static Ids(list: readonly { id: string }[]): string[]
    {
        return list.map(m => m.id).sort()
    }

    public static async Adopts(reg: PlatformDeploymentRegistry, v: string): Promise<boolean>
    {
        try
        {
            await reg.RecordAdoption(Fx.HiveA, v)
            return true
        }
        catch
        {
            return false
        }
    }
}

test('policy: plain gated version is offered and adoptable', async () =>
{
    await Fx.Run(async reg =>
    {
        await Fx.PublishGated(reg, [Fx.V1])
        assert.deepEqual(EnforceFx.Ids(reg.AdoptableFor(Fx.HiveA)), [Fx.V1])
        await reg.RecordAdoption(Fx.HiveA, Fx.V1)
    })
})

test('policy: withdrawn is excluded and rejected, restore re-enables', async () =>
{
    await Fx.Run(async reg =>
    {
        await Fx.PublishGated(reg, [Fx.V1])
        await reg.SetWithdrawn(Fx.V1, true, 'bad', Fx.Operator)
        assert.deepEqual(reg.AdoptableFor(Fx.HiveA), [])
        await assert.rejects(reg.RecordAdoption(Fx.HiveA, Fx.V1), ManifestWithdrawnError)
        await reg.SetWithdrawn(Fx.V1, false)
        assert.deepEqual(EnforceFx.Ids(reg.AdoptableFor(Fx.HiveA)), [Fx.V1])
        await reg.RecordAdoption(Fx.HiveA, Fx.V1)
    })
})

test('policy: hold blocks everything until cleared', async () =>
{
    await Fx.Run(async reg =>
    {
        await Fx.PublishGated(reg, [Fx.V1, Fx.V2])
        await reg.SetHold(Fx.TenantA, 'freeze', Fx.Operator)
        assert.deepEqual(reg.AdoptableFor(Fx.HiveA), [])
        await assert.rejects(reg.RecordAdoption(Fx.HiveA, Fx.V1), TenantOnHoldError)
        await reg.ClearHold(Fx.TenantA)
        assert.deepEqual(EnforceFx.Ids(reg.AdoptableFor(Fx.HiveA)), [Fx.V1, Fx.V2])
        await reg.RecordAdoption(Fx.HiveA, Fx.V1)
    })
})

test('policy: channels filter; absent or empty means all allowed', async () =>
{
    await Fx.Run(async reg =>
    {
        await reg.Publish(Fx.V1, Fx.Image(Fx.V1), undefined, Channel.EarlyAccess)
        await reg.Gate(Fx.TenantA, Fx.V1)
        await reg.Publish(Fx.V2, Fx.Image(Fx.V2), undefined, Channel.Stable)
        await reg.Gate(Fx.TenantA, Fx.V2)
        await reg.RecordAdoption(Fx.HiveA, Fx.V1)
        await reg.SetChannels(Fx.TenantA, [Channel.Stable])
        assert.deepEqual(EnforceFx.Ids(reg.AdoptableFor(Fx.HiveA)), [Fx.V2])
        await assert.rejects(reg.RecordAdoption(Fx.HiveA, Fx.V1), ChannelNotSubscribedError)
        await reg.RecordAdoption(Fx.HiveA, Fx.V2)
        await reg.SetChannels(Fx.TenantA, [])
        assert.deepEqual(EnforceFx.Ids(reg.AdoptableFor(Fx.HiveA)), [Fx.V1, Fx.V2])
        await reg.RecordAdoption(Fx.HiveA, Fx.V1)
    })
})

test('policy: floor excludes lower versions, boundary passes', async () =>
{
    await Fx.Run(async reg =>
    {
        await Fx.PublishGated(reg, ['1.9.0', '1.10.0'])
        await reg.SetMinVersion(Fx.TenantA, '1.10.0')
        assert.deepEqual(EnforceFx.Ids(reg.AdoptableFor(Fx.HiveA)), ['1.10.0'])
        await assert.rejects(reg.RecordAdoption(Fx.HiveA, '1.9.0'), VersionBelowFloorError)
        await reg.RecordAdoption(Fx.HiveA, '1.10.0')
    })
})

test('policy: precedence held before channel before floor', async () =>
{
    await Fx.Run(async reg =>
    {
        await reg.Publish(Fx.V1, Fx.Image(Fx.V1), undefined, Channel.EarlyAccess)
        await reg.Gate(Fx.TenantA, Fx.V1)
        await reg.SetMinVersion(Fx.TenantA, Fx.V2)
        await reg.SetChannels(Fx.TenantA, [Channel.Stable])
        await reg.SetHold(Fx.TenantA, 'freeze', Fx.Operator)
        await assert.rejects(reg.RecordAdoption(Fx.HiveA, Fx.V1), TenantOnHoldError)
        await reg.ClearHold(Fx.TenantA)
        await assert.rejects(reg.RecordAdoption(Fx.HiveA, Fx.V1), ChannelNotSubscribedError)
        await reg.SetChannels(Fx.TenantA, [Channel.Stable, Channel.EarlyAccess])
        await assert.rejects(reg.RecordAdoption(Fx.HiveA, Fx.V1), VersionBelowFloorError)
    })
})

test('policy: reported equals enforced over a mixed set', async () =>
{
    await Fx.Run(async reg =>
    {
        await Fx.PublishGated(reg, ['1.9.0', '1.10.0', Fx.V2, Fx.V3])
        await reg.Publish('9.0.0', Fx.Image('9.0.0'))
        await reg.SetWithdrawn(Fx.V2, true, 'bad', Fx.Operator)
        await reg.SetMinVersion(Fx.TenantA, '1.10.0')
        const offered = EnforceFx.Ids(reg.AdoptableForTenant(Fx.TenantA))
        const adoptable: string[] = []
        for (const v of ['1.9.0', '1.10.0', Fx.V2, Fx.V3, '9.0.0'])
        {
            if (await EnforceFx.Adopts(reg, v))
            {
                adoptable.push(v)
            }
        }
        assert.deepEqual(offered, adoptable.sort())
        assert.deepEqual(offered, ['1.10.0', Fx.V3])
    })
})

test('policy: withdrawn takes precedence over floor', async () =>
{
    await Fx.Run(async reg =>
    {
        await Fx.PublishGated(reg, [Fx.V1])
        await reg.SetWithdrawn(Fx.V1, true, 'bad', Fx.Operator)
        await reg.SetMinVersion(Fx.TenantA, Fx.V2)
        await assert.rejects(reg.RecordAdoption(Fx.HiveA, Fx.V1), ManifestWithdrawnError)
    })
})

test('ledger records Gate, Ungate, SetWithdrawn and restore with their targets', async () =>
{
    await Fx.Run(async (reg, _registrations, _rolls, ledger) =>
    {
        await reg.Publish(Fx.V1, Fx.Image(Fx.V1))
        assert.equal(ledger.List().length, 0)
        await reg.Gate(Fx.TenantA, Fx.V1)
        await reg.SetWithdrawn(Fx.V1, true, 'bad', Fx.Operator)
        await reg.SetWithdrawn(Fx.V1, false)
        await reg.Ungate(Fx.TenantA, Fx.V1)
        const byAction = new Map(ledger.List().map(r => [r.action, r]))
        assert.equal(byAction.size, 4)
        assert.equal(byAction.get('gated')?.tenantId, Fx.TenantA)
        assert.equal(byAction.get('gated')?.version, Fx.V1)
        assert.equal(byAction.get('ungated')?.tenantId, Fx.TenantA)
        assert.equal(byAction.get('withdrawn')?.version, Fx.V1)
        assert.equal(byAction.get('withdrawn')?.tenantId, undefined)
        assert.equal(byAction.get('restored')?.version, Fx.V1)
    })
})

test('ledger records selected and adopted with hive, tenant and version, newest first', async () =>
{
    await Fx.Run(async (reg, _registrations, _rolls, ledger) =>
    {
        await Fx.PublishGated(reg, [Fx.V1, Fx.V2])
        await reg.SelectTarget(Fx.HiveA, Fx.V1)
        await new Promise(r => setTimeout(r, 3))
        await reg.RecordAdoption(Fx.HiveA, Fx.V2)
        const series = reg.LedgerFor(Fx.HiveA, 10)
        assert.deepEqual(series.map(r => r.action), ['adopted', 'selected'])
        assert.deepEqual(series.map(r => r.version), [Fx.V2, Fx.V1])
        assert.equal(series[0]?.hiveId, Fx.HiveA)
        assert.equal(series[0]?.tenantId, Fx.TenantA)
        assert.equal(ledger.ForHive(Fx.HiveA, 1).length, 1)
    })
})

test('a policy-blocked adopt or select appends nothing to the ledger', async () =>
{
    await Fx.Run(async (reg, _registrations, _rolls, ledger) =>
    {
        await Fx.PublishGated(reg, [Fx.V1])
        await reg.SetHold(Fx.TenantA, 'freeze', Fx.Operator)
        const before = ledger.List().length
        await assert.rejects(reg.RecordAdoption(Fx.HiveA, Fx.V1), TenantOnHoldError)
        await assert.rejects(reg.SelectTarget(Fx.HiveA, Fx.V1), TenantOnHoldError)
        assert.equal(ledger.List().length, before)
        assert.deepEqual(reg.LedgerFor(Fx.HiveA, 10), [])
    })
})

test('a throwing ledger store does not break Gate or RecordAdoption', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), Fx.Prefix))
    try
    {
        await Fx.Run(async reg =>
        {
            await reg.Publish(Fx.V1, Fx.Image(Fx.V1))
            await reg.Gate(Fx.TenantA, Fx.V1)
            await reg.RecordAdoption(Fx.HiveA, Fx.V1)
            assert.equal(reg.TargetFor(Fx.HiveA)?.version, Fx.V1)
            assert.equal(reg.ManifestsFor(Fx.TenantA).length, 1)
        }, false, undefined, true, new ThrowingLedger(join(dir, 'throw.json')))
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})
