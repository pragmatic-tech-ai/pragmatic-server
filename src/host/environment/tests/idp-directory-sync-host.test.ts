import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DelegationDepth, IdentityConfig, IdpDirectoryRequest, IdpDirectorySnapshot, IdpDirectorySync, IdpUserState, Tenant, TenantKind } from '@pragmatic-tech-ai/todl-identity'
import type { IIdpDirectorySource, IIdpDirectoryStore, ISecurityModelConfig, ITenantConfigStore } from '@pragmatic-tech-ai/todl-identity'
import { FakeAuditSink, FakeSessionManager } from '@pragmatic-tech-ai/todl-identity/testing'
import { Disposable } from '@pragmatic-tech-ai/todl-runtime'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { EnvironmentSecuritySetting } from '../environment-security-setting.js'
import { IdpDirectorySyncHost } from '../idp-directory-sync-host.js'
import type { ISyncDiagnostics, ISyncTimer } from '../idp-directory-sync-host.js'
import { PragmaticServer } from '../../../pragmatic-server.js'
import { TenantPurpose } from '../../../tenancy/tenant-purpose.js'
import { EnvironmentFixture } from './environment-fixture.js'

/** A config store whose stored security model can be swapped between runs. */
class MutableConfigStore implements ITenantConfigStore
{
    public constructor(public model: ISecurityModelConfig | undefined)
    {
    }

    public async Get(_tenantId: string): Promise<IdentityConfig | null>
    {
        return this.model === undefined ? null : new IdentityConfig('local', DelegationDepth.FullAuthz, new Map(), new Map(), new Map(), this.model)
    }

    public async Save(): Promise<void>
    {
    }

    public async List(): Promise<readonly string[]>
    {
        return []
    }
}

/** An in-memory directory store that records how many snapshots were saved. */
class MemoryDirectoryStore implements IIdpDirectoryStore
{
    public saved: IdpDirectorySnapshot | null = null
    public saves = 0

    public constructor(seed: IdpDirectorySnapshot | null = null)
    {
        this.saved = seed
    }

    public async Get(_tenantId: string): Promise<IdpDirectorySnapshot | null>
    {
        return this.saved
    }

    public async Save(_tenantId: string, snapshot: IdpDirectorySnapshot): Promise<void>
    {
        this.saved = snapshot
        this.saves++
    }
}

/** Records every request; optionally blocks the first call on a gate or fails every call. */
class RecordingSource implements IIdpDirectorySource
{
    public readonly Requests: IdpDirectoryRequest[] = []
    public readonly Authoritative = true
    public Fail: Error | undefined
    public HoldFirst: Promise<void> | undefined
    private held = false

    public constructor(private next: IdpDirectorySnapshot)
    {
    }

    public SetNext(next: IdpDirectorySnapshot): void
    {
        this.next = next
    }

    public async Snapshot(_tenant: Tenant, request: IdpDirectoryRequest): Promise<IdpDirectorySnapshot>
    {
        this.Requests.push(request)
        if (this.HoldFirst !== undefined && !this.held)
        {
            this.held = true
            await this.HoldFirst
        }
        if (this.Fail !== undefined)
        {
            throw this.Fail
        }
        return this.next
    }
}

class ManualTimer implements ISyncTimer
{
    public run: (() => void) | undefined
    public disposed = false

    public Every(_ms: number, run: () => void): IDisposable
    {
        this.run = run
        return new Disposable(() => { this.disposed = true })
    }

    public Tick(): void
    {
        this.run?.()
    }
}

class RecordingDiagnostics implements ISyncDiagnostics
{
    public readonly Failures: string[] = []

    public Failed(_tenantId: string, error: Error): void
    {
        this.Failures.push(error.name)
    }
}

class SyncFx
{
    public static readonly Tenant = new Tenant('env1', TenantKind.SelfHosted, 'Environment One')

    public static Model(groups: readonly string[]): ISecurityModelConfig
    {
        return {
            businessUnits: [], users: [], roleAssignments: [], profileAssignments: [], roleOverrides: [], profileOverrides: [],
            teams: [{ id: 't1', name: 'Team', businessUnitId: '', idpGroups: [...groups], manualMembers: [] }],
        }
    }

    public static Snapshot(users: Readonly<Record<string, IdpUserState>> = {}, groups: Readonly<Record<string, readonly string[]>> = {}): IdpDirectorySnapshot
    {
        return new IdpDirectorySnapshot(new Date(), true, new Map(Object.entries(users)), new Map(Object.entries(groups)))
    }

    /** A host over a fresh setting, the recording source and an in-memory directory store; returns the parts a test asserts on. */
    public static Make(options: { model?: ISecurityModelConfig; next?: IdpDirectorySnapshot; seed?: IdpDirectorySnapshot | null } = {}): {
        host: IdpDirectorySyncHost; source: RecordingSource; store: MemoryDirectoryStore; setting: EnvironmentSecuritySetting; config: MutableConfigStore; timer: ManualTimer; diagnostics: RecordingDiagnostics
    }
    {
        const config = new MutableConfigStore(options.model ?? SyncFx.Model(['g1']))
        const store = new MemoryDirectoryStore(options.seed ?? null)
        const source = new RecordingSource(options.next ?? SyncFx.Snapshot())
        const setting = new EnvironmentSecuritySetting(config, store, SyncFx.Tenant)
        const sync = new IdpDirectorySync(source, store, new FakeSessionManager(), new FakeAuditSink())
        const timer = new ManualTimer()
        const diagnostics = new RecordingDiagnostics()
        const host = new IdpDirectorySyncHost(sync, setting, SyncFx.Tenant, timer, diagnostics)
        return { host, source, store, setting, config, timer, diagnostics }
    }

    public static async Settle(): Promise<void>
    {
        await new Promise(resolve => setTimeout(resolve, 10))
    }
}

describe('idp directory sync host', () =>
{
    test('sync runs on start and after a setting change, each against the current setting', async () =>
    {
        const fx = SyncFx.Make({ model: SyncFx.Model(['g1']) })
        try
        {
            await fx.host.RunNow()
            assert.equal(fx.source.Requests.length, 1, 'one run on start')
            assert.deepEqual([...fx.source.Requests[0]!.GroupIds], ['g1'])
            fx.config.model = SyncFx.Model(['g2'])
            await fx.host.RunNow()
            assert.equal(fx.source.Requests.length, 2, 'a second run after the setting change')
            assert.deepEqual([...fx.source.Requests[1]!.GroupIds], ['g2'], 'the second run asks about the changed groups')
        }
        finally
        {
            fx.host.dispose()
        }
    })

    test('the interval timer drives a run', async () =>
    {
        const fx = SyncFx.Make()
        try
        {
            assert.equal(fx.source.Requests.length, 0)
            fx.timer.Tick()
            await SyncFx.Settle()
            assert.equal(fx.source.Requests.length, 1, 'a tick pulls the directory')
        }
        finally
        {
            fx.host.dispose()
        }
    })

    test('concurrent requests coalesce into one more run', async () =>
    {
        const fx = SyncFx.Make()
        let release: () => void = () => {}
        fx.source.HoldFirst = new Promise<void>(resolve => { release = resolve })
        try
        {
            const first = fx.host.RunNow()
            const second = fx.host.RunNow()
            const third = fx.host.RunNow()
            release()
            await Promise.all([first, second, third])
            assert.equal(fx.source.Requests.length, 2, 'the in-flight run plus one coalesced run, not three')
        }
        finally
        {
            fx.host.dispose()
        }
    })

    test('a failed sync keeps the previous snapshot and is logged by error name', async () =>
    {
        const previous = SyncFx.Snapshot({ alice: IdpUserState.Enabled })
        const fx = SyncFx.Make({ seed: previous })
        fx.source.Fail = new TypeError('idp unreachable')
        try
        {
            const before = fx.setting.Generation
            await fx.host.RunNow()
            assert.equal(fx.store.saves, 0, 'nothing was stored')
            assert.equal(fx.store.saved, previous, 'the previous snapshot is untouched')
            assert.equal(fx.setting.Generation, before, 'a failed run does not invalidate')
            assert.deepEqual(fx.diagnostics.Failures, ['TypeError'])
        }
        finally
        {
            fx.host.dispose()
        }
    })

    test('a successful sync invalidates the setting so the next scope reads the new snapshot', async () =>
    {
        const fx = SyncFx.Make()
        try
        {
            const before = fx.setting.Generation
            await fx.host.RunNow()
            assert.equal(fx.setting.Generation, before + 1, 'the setting generation advanced')
            assert.equal(fx.store.saves, 1)
        }
        finally
        {
            fx.host.dispose()
        }
    })

    test('deprovisioned principals are signalled (R27)', async () =>
    {
        const previous = SyncFx.Snapshot({ alice: IdpUserState.Enabled })
        const next = SyncFx.Snapshot({ alice: IdpUserState.Disabled })
        const fx = SyncFx.Make({ seed: previous, next })
        const signalled: string[][] = []
        const subscription = fx.host.Deprovisioned.Subscribe(ids => signalled.push([...ids]))
        try
        {
            await fx.host.RunNow()
            assert.deepEqual(signalled, [['alice']], 'the run raised the deprovisioned principal id')
        }
        finally
        {
            subscription.dispose()
            fx.host.dispose()
        }
    })

    test('dispose stops the timer and later runs are no-ops', async () =>
    {
        const fx = SyncFx.Make()
        fx.host.dispose()
        assert.equal(fx.timer.disposed, true)
        await fx.host.RunNow()
        assert.equal(fx.source.Requests.length, 0, 'a disposed host does not sync')
    })

    test('a runtime tenant syncs when it starts serving, without any connection', async () =>
    {
        const fx = new EnvironmentFixture()
        let restarted: PragmaticServer | undefined
        try
        {
            // a stored setting (the sync has something to ask about), then a restart: nothing connects to the new server
            await fx.Start({ Identity: true, SecurityModel: SyncStartFx.Setting })
            await fx.Server.Dispose()
            restarted = new PragmaticServer({
                purpose: TenantPurpose.Runtime,
                packagesRoot: fx.PackagesDir,
                applicationsRoot: fx.AppsDir,
                graphsRoot: fx.GraphsDir,
                identity: { identityRoot: fx.IdentityDir, masterKey: { base64Env: EnvironmentFixture.KeyEnv }, tenant: { id: EnvironmentFixture.TenantId, displayName: SyncStartFx.DisplayName } },
            })
            await restarted.Start()
            const store = (await restarted.Pack()).IdpDirectory
            for (let tick = 0; tick < SyncStartFx.MaxTicks && (await store.Get(EnvironmentFixture.TenantId)) === null; tick++) await new Promise(resolve => setTimeout(resolve, SyncStartFx.TickMs))
            assert.notEqual(await store.Get(EnvironmentFixture.TenantId), null, 'Start ran the first sync: the directory snapshot is stored')
        }
        finally
        {
            await restarted?.Dispose()
            await fx.Dispose()
        }
    })
})

class SyncStartFx
{
    public static readonly MaxTicks = 100
    public static readonly TickMs = 10
    public static readonly DisplayName = 'Environment One'
    public static readonly Setting: ISecurityModelConfig = { businessUnits: [{ id: 'root', name: 'Root' }], users: [], teams: [], roleAssignments: [], profileAssignments: [], roleOverrides: [], profileOverrides: [] }
}
