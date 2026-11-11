import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccessDefault, AccessScope, FalsePredicate, StorageKind } from '@pragmatic-tech-ai/graph'
import { TodlNames } from '@pragmatic-tech-ai/todl/engine'
import { AppWriteOpKind, AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AppWriteOpDto, AppWriteResultDto, DataChangedPayload, PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import { Principal, PrincipalKind } from '@pragmatic-tech-ai/todl-identity'
import { Disposable } from '@pragmatic-tech-ai/todl-runtime'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { PragmaticServer } from '../../../pragmatic-server.js'
import { TenantPurpose } from '../../../tenancy/tenant-purpose.js'
import type { IGraphScope } from '../../engine/access-scope-source.js'
import type { IUpgradeTimer } from '../../engine/bounded-wait.js'
import { ServerConnectionHandler } from '../../server-connection-handler.js'
import { ScopedAccessContext, TokenScope } from '../../token-scope.js'
import { NullLogger } from '../../../observability/logger.js'
import { DataChangedPush, LoggerDataChangedDiagnostics } from '../data-changed-push.js'
import { EnvironmentEngineHost } from '../environment-engine-host.js'
import type { EnvironmentSnapshot } from '../environment-engine-host.js'
import { EnvironmentFixture } from './environment-fixture.js'
import type { IEnvironmentFixtureOptions } from './environment-fixture.js'

/** Runs each started work only when `Fire` is called. */
class ManualTimer implements IUpgradeTimer
{
    public readonly Delays: number[] = []
    private readonly pending: (() => void)[] = []

    public Start(delayMs: number, work: () => void): IDisposable
    {
        this.Delays.push(delayMs)
        this.pending.push(work)
        return new Disposable(() =>
        {
            const at = this.pending.indexOf(work)
            if (at >= 0) this.pending.splice(at, 1)
        })
    }

    public Fire(): void
    {
        for (const work of this.pending.splice(0)) work()
    }
}

/** A scope reading everything but `concept` (a constant False entry); it places nothing. */
class DenyingScope implements IGraphScope
{
    private static readonly NoPlacement = 'the denying scope places nothing'
    public readonly Digest = 'denying'
    public readonly Scope: AccessScope

    public constructor(concept: string)
    {
        this.Scope = AccessScope.Build({ Default: AccessDefault.Allow, Rows: new Map([[concept, FalsePredicate.Instance]]) })
    }

    public Placement(): never
    {
        throw new Error(DenyingScope.NoPlacement)
    }
}

/** A host whose running snapshot can be hidden, as during a reopen. */
class GatedHost extends EnvironmentEngineHost
{
    public Reopening = false

    public static Over(fx: EnvironmentFixture): GatedHost
    {
        return fx.Track(new GatedHost(fx.Deliveries(), new NodeFsStorage(fx.PackagesDir), fx.Services(), { Kind: StorageKind.Lmdb, Path: fx.StorePath }))
    }

    public override RunningSnapshot(): EnvironmentSnapshot | undefined
    {
        return this.Reopening ? undefined : super.RunningSnapshot()
    }
}

/** Every data/changed payload one client received. */
class Inbox
{
    private static readonly TimeoutMessage = 'no data/changed payload arrived'
    private static readonly WaitMs = 2000
    private static readonly QuietMs = 200

    public readonly Payloads: DataChangedPayload[] = []
    private waiter: (() => void) | undefined

    public constructor(client?: PragmaticClient)
    {
        client?.OnDataChanged(payload => this.Receive(payload))
    }

    public Receive(payload: DataChangedPayload): void
    {
        this.Payloads.push(payload)
        this.waiter?.()
    }

    /** Waits until at least `count` payloads arrived. */
    public async Await(count: number = 1): Promise<readonly DataChangedPayload[]>
    {
        const deadline = Date.now() + Inbox.WaitMs
        while (this.Payloads.length < count)
        {
            if (Date.now() > deadline) throw new Error(Inbox.TimeoutMessage)
            await new Promise<void>(resolve =>
            {
                this.waiter = resolve
                setTimeout(resolve, 20)
            })
        }
        return this.Payloads
    }

    /** Waits until a payload carrying `commit` arrived and returns it (other payloads, e.g. a reopen's root, may come first). */
    public async AwaitCommit(commit: string): Promise<DataChangedPayload>
    {
        const deadline = Date.now() + Inbox.WaitMs
        let found = this.Payloads.find(payload => payload.commit === commit)
        while (found === undefined)
        {
            if (Date.now() > deadline) throw new Error(Inbox.TimeoutMessage)
            await new Promise<void>(resolve =>
            {
                this.waiter = resolve
                setTimeout(resolve, 20)
            })
            found = this.Payloads.find(payload => payload.commit === commit)
        }
        return found
    }

    /** Lets any further push arrive (beyond the coalescing window). */
    public static Quiet(): Promise<void>
    {
        return new Promise(resolve => setTimeout(resolve, Inbox.QuietMs))
    }
}

/**
 * `crm` (crm.Account, crm.Contact, engine-stored) live through `crm-app`; `ext` (ext.Customer bound writable over the
 * fixture's MemorySourceAdapter with a text id member) live through `ext-app` unless `external` is false; no identity
 * (Default Allow), so every connection reads everything.
 */
class PushFx
{
    public static readonly App = 'crm-app'
    public static readonly ExtApp = 'ext-app'
    public static readonly AppVersion = '1.0.0'
    public static readonly NextVersion = '1.0.1'
    public static readonly Crm = { id: 'crm', version: '1.0.0' }
    public static readonly CrmNext = { id: 'crm', version: '1.0.1' }
    public static readonly Ext = { id: 'ext', version: '1.0.0' }
    public static readonly CrmTodl = 'namespace crm {\n  concept Account { name : string?; owner : string?; }\n  concept Contact { name : string?; }\n  model Crm : crm { }\n}\n'
    public static readonly CrmNextTodl = 'namespace crm {\n  concept Account { name : string?; owner : string?; }\n  concept Contact { name : string?; }\n  concept Lead { name : string?; }\n  model Crm : crm { }\n}\n'
    public static readonly ExtTodl = 'namespace ext {\n  concept Customer { id : string?; name : string?; }\n  datasource src { kind = sql; connection = "ext-db"; }\n'
        + '  model Ext : ext { connect src; populate Customer key cust_id { name = "nm"; } }\n}\n'
    public static readonly Account = 'crm.Account'
    public static readonly Contact = 'crm.Contact'
    public static readonly Customer = 'ext.Customer'
    public static readonly Name = 'name'
    public static readonly A = 'a'
    public static readonly R1 = 'r1'
    public static readonly R2 = 'r2'
    public static readonly R3 = 'r3'
    public static readonly K5 = 'k5'
    public static readonly P1 = 'p1'
    /** Diagnostics for the tests that provoke skipped subscribers on purpose. */
    public static readonly Silent = new LoggerDataChangedDiagnostics(new NullLogger())
    public static readonly DevPrefix = 'ps-push-dev-'

    public static Principal(id: string): Principal
    {
        return new Principal(id, EnvironmentFixture.TenantId, PrincipalKind.User, new Map(), [])
    }

    public static async Run(options: IEnvironmentFixtureOptions, body: (fx: EnvironmentFixture) => Promise<void>, external: boolean = true): Promise<void>
    {
        const fx = new EnvironmentFixture()
        try
        {
            await fx.Package(PushFx.Crm.id, PushFx.Crm.version, PushFx.CrmTodl)
            await fx.Package(PushFx.Ext.id, PushFx.Ext.version, PushFx.ExtTodl)
            fx.Live(PushFx.App, PushFx.AppVersion, [PushFx.Crm])
            if (external) fx.Live(PushFx.ExtApp, PushFx.AppVersion, [PushFx.Ext])
            await fx.Start(options)
            await body(fx)
        }
        finally
        {
            await fx.Dispose()
        }
    }

    public static Write(fx: EnvironmentFixture, operations: AppWriteOpDto[]): Promise<AppWriteResultDto>
    {
        return fx.Server.WriteForPragmaticApp(fx.ContextFor(PushFx.Principal(PushFx.P1)), PushFx.App, operations)
    }

    public static async Applied(fx: EnvironmentFixture, operations: AppWriteOpDto[]): Promise<void>
    {
        const result = await PushFx.Write(fx, operations)
        for (const op of result.results) assert.equal(op.status, AppWriteStatus.Applied, JSON.stringify(result))
    }

    /** The current snapshot commit, as a decimal (what a push names). */
    public static async Commit(fx: EnvironmentFixture): Promise<string>
    {
        const reader = await (await fx.Server.EnvironmentEngine().Engine()).BeginRead(AccessScope.System)
        try
        {
            return String(reader.SnapshotCommit)
        }
        finally
        {
            reader.dispose()
        }
    }

    public static Connect(fx: EnvironmentFixture, principal: string = PushFx.P1): Promise<PragmaticClient>
    {
        return fx.Connect(PushFx.Principal(principal))
    }
}

describe('data/changed push', () =>
{
    test('write pushes its concept; an upgrade pushes the root', async () =>
    {
        await PushFx.Run({}, async fx =>
        {
            const inbox = new Inbox(await PushFx.Connect(fx))
            await PushFx.Applied(fx, [{ op: AppWriteOpKind.Create, concept: PushFx.Account, fields: { [PushFx.Name]: PushFx.A } }])
            const commit = await PushFx.Commit(fx)
            assert.deepEqual(await inbox.Await(), [{ commit, concepts: [PushFx.Account] }])
            // an in-place upgrade (same connector set, a new package version) is an Upgrade commit: the root
            await fx.Package(PushFx.CrmNext.id, PushFx.CrmNext.version, PushFx.CrmNextTodl)
            fx.Live(PushFx.App, PushFx.NextVersion, [PushFx.CrmNext])
            await fx.Server.EnvironmentEngine().Redeliver()
            const upgraded = await inbox.Await(2)
            assert.deepEqual(upgraded[1], { commit: await PushFx.Commit(fx), concepts: [TodlNames.Element] })
        })
    })

    test('unreadable concept is not pushed', async () =>
    {
        await PushFx.Run({}, async fx =>
        {
            const reader = new Inbox(await PushFx.Connect(fx))
            const denied = new Inbox()
            const scope = new DenyingScope(PushFx.Account)
            fx.Server.DataChanges().Subscribe(async () => scope, payload => denied.Receive(payload))
            await fx.Seed([{ Concept: PushFx.Account, Id: PushFx.R1 }])
            assert.deepEqual((await reader.Await()).map(payload => payload.concepts), [[PushFx.Account]])
            await Inbox.Quiet()
            assert.deepEqual(denied.Payloads, [], 'a scope denying crm.Account gets nothing')
            await fx.Seed([{ Concept: PushFx.Contact, Id: PushFx.R2 }])
            assert.deepEqual((await denied.Await()).map(payload => payload.concepts), [[PushFx.Contact]], 'a readable concept still arrives')
        })
    })

    test('delete is attributed to the root concept', async () =>
    {
        await PushFx.Run({}, async fx =>
        {
            await fx.Seed([{ Concept: PushFx.Account, Id: PushFx.R1 }])
            const inbox = new Inbox(await PushFx.Connect(fx))
            await PushFx.Applied(fx, [{ op: AppWriteOpKind.Delete, concept: PushFx.Account, id: PushFx.R1 }])
            assert.deepEqual(await inbox.Await(), [{ commit: await PushFx.Commit(fx), concepts: [TodlNames.Element] }])
        })
    })

    test('external write is pushed from ConnectorApplied', async () =>
    {
        await PushFx.Run({}, async fx =>
        {
            const inbox = new Inbox(await PushFx.Connect(fx))
            const before = await PushFx.Commit(fx)
            await PushFx.Applied(fx, [{ op: AppWriteOpKind.Create, concept: PushFx.Customer, id: PushFx.K5, fields: { [PushFx.Name]: PushFx.A } }])
            assert.equal(await PushFx.Commit(fx), before, 'the external write made no engine commit')
            assert.deepEqual(await inbox.Await(), [{ commit: before, concepts: [PushFx.Customer] }])
        })
    })

    test('write-through with an engine commit is pushed once', async () =>
    {
        await PushFx.Run({}, async fx =>
        {
            const inbox = new Inbox(await PushFx.Connect(fx))
            await PushFx.Applied(fx, [
                { op: AppWriteOpKind.Create, concept: PushFx.Account, fields: { [PushFx.Name]: PushFx.A } },
                { op: AppWriteOpKind.Create, concept: PushFx.Customer, id: PushFx.K5, fields: { [PushFx.Name]: PushFx.A } },
            ])
            const commit = await PushFx.Commit(fx)
            await inbox.Await()
            await Inbox.Quiet()
            assert.deepEqual(inbox.Payloads, [{ commit, concepts: [PushFx.Account, PushFx.Customer] }])
        })
    })

    test('two commits within the window coalesce; a disposed subscription gets nothing', async () =>
    {
        await PushFx.Run({}, async fx =>
        {
            const timer = new ManualTimer()
            const push = new DataChangedPush(fx.Server.EnvironmentEngine(), timer)
            try
            {
                const context = fx.ContextFor(PushFx.Principal(PushFx.P1))
                const scope = async () => (await fx.Server.EnvironmentScopes()).ScopeFor(context)
                const live = new Inbox()
                const gone = new Inbox()
                push.Subscribe(scope, payload => live.Receive(payload))
                push.Subscribe(scope, payload => gone.Receive(payload)).dispose()
                await fx.Server.EnvironmentEngine().Engine()
                await fx.Seed([{ Concept: PushFx.Contact, Id: PushFx.R1 }])
                await fx.Seed([{ Concept: PushFx.Account, Id: PushFx.R2 }])
                assert.deepEqual(timer.Delays, [DataChangedPush.CoalesceMs], 'one window for both commits')
                timer.Fire()
                assert.deepEqual(await live.Await(), [{ commit: await PushFx.Commit(fx), concepts: [PushFx.Account, PushFx.Contact] }])
                await Inbox.Quiet()
                assert.equal(live.Payloads.length, 1)
                assert.deepEqual(gone.Payloads, [], 'disposed subscription gets nothing')
            }
            finally
            {
                push.dispose()
            }
        })
    })

    test('a commit received while a flush is queued opens the next window', async () =>
    {
        await PushFx.Run({}, async fx =>
        {
            const timer = new ManualTimer()
            const host = fx.Server.EnvironmentEngine()
            const push = new DataChangedPush(host, timer, PushFx.Silent)
            try
            {
                const context = fx.ContextFor(PushFx.Principal(PushFx.P1))
                let release: () => void = () => {}
                const gate = new Promise<void>(resolve => { release = resolve })
                let calls = 0
                // the first flush blocks in its scope until released, so the steps behind it stay queued
                const scope = async () =>
                {
                    if (calls++ === 0) await gate
                    return (await fx.Server.EnvironmentScopes()).ScopeFor(context)
                }
                const inbox = new Inbox()
                push.Subscribe(scope, payload => inbox.Receive(payload))
                await host.Engine()
                const a = await fx.Seed([{ Concept: PushFx.Account, Id: PushFx.R1 }])
                timer.Fire()
                await Inbox.Quiet()
                const b = await fx.Seed([{ Concept: PushFx.Contact, Id: PushFx.R2 }])
                timer.Fire()
                // received while the second window's flush is still queued behind the blocked first one
                const c = await fx.Seed([{ Concept: PushFx.Account, Id: PushFx.R3 }])
                release()
                await Inbox.Quiet()
                timer.Fire()
                assert.deepEqual((await inbox.Await(3)).map(payload => payload.commit), [String(a), String(b), String(c)], 'the late commit is pushed')
            }
            finally
            {
                push.dispose()
            }
        })
    })

    test('a connection without cypher/query, or disposed, gets nothing', async () =>
    {
        await PushFx.Run({}, async fx =>
        {
            const context = fx.ContextFor(PushFx.Principal(PushFx.P1))
            const control = new Inbox((await fx.ConnectWith(context)).Client)
            const scoped = new Inbox((await fx.ConnectWith(new ScopedAccessContext(context, [TokenScope.GraphContribute]))).Client)
            const closing = await fx.ConnectWith(context)
            const closed = new Inbox(closing.Client)
            closing.Handler.Dispose()
            await fx.Seed([{ Concept: PushFx.Account, Id: PushFx.R1 }])
            assert.deepEqual((await control.Await()).map(payload => payload.concepts), [[PushFx.Account]])
            await Inbox.Quiet()
            assert.deepEqual(scoped.Payloads, [], 'a token scope without cypher/query gets nothing')
            assert.deepEqual(closed.Payloads, [], 'a disposed connection gets nothing')
        })
    })

    test('a window due during a reopen is carried by the next one', async () =>
    {
        await PushFx.Run({}, async fx =>
        {
            // a standalone host on the store (the server's own engine is never opened in this test)
            const host = GatedHost.Over(fx)
            const timer = new ManualTimer()
            const push = new DataChangedPush(host, timer, PushFx.Silent)
            try
            {
                const inbox = new Inbox()
                const scope = new DenyingScope(PushFx.Customer)
                push.Subscribe(async () => scope, payload => inbox.Receive(payload))
                await host.Engine()
                await fx.Seed([{ Concept: PushFx.Account, Id: PushFx.R1 }], host)
                host.Reopening = true
                timer.Fire()
                await Inbox.Quiet()
                assert.deepEqual(inbox.Payloads, [], 'nothing to filter with while reopening')
                host.Reopening = false
                const latest = await fx.Seed([{ Concept: PushFx.Contact, Id: PushFx.R2 }], host)
                timer.Fire()
                assert.deepEqual(await inbox.Await(), [{ commit: String(latest), concepts: [PushFx.Account, PushFx.Contact] }], 'the requeued change joins the next window')
            }
            finally
            {
                push.dispose()
            }
        })
    })

    test('a subscriber skipped while a reopen began hears the root after it', async () =>
    {
        await PushFx.Run({}, async fx =>
        {
            const host = GatedHost.Over(fx)
            const timer = new ManualTimer()
            const push = new DataChangedPush(host, timer, PushFx.Silent)
            try
            {
                const inbox = new Inbox()
                const denying = new DenyingScope(PushFx.Customer)
                let calls = 0
                // the first flush sees a reopen begin while this subscriber's scope resolves: it is skipped
                const scope = async () =>
                {
                    if (calls++ === 0) host.Reopening = true
                    return denying
                }
                push.Subscribe(scope, payload => inbox.Receive(payload))
                const first = await host.Engine()
                await fx.Seed([{ Concept: PushFx.Account, Id: PushFx.R1 }], host)
                timer.Fire()
                await Inbox.Quiet()
                assert.deepEqual(inbox.Payloads, [], 'skipped for the window')
                host.Reopening = false
                // a new external connector set reopens the engine
                fx.Live(PushFx.ExtApp, PushFx.AppVersion, [PushFx.Ext])
                await host.Redeliver()
                const reopened = await host.Engine()
                assert.notEqual(reopened, first, 'the engine was reopened')
                await Inbox.Quiet()
                timer.Fire()
                const reader = await reopened.BeginRead(AccessScope.System)
                const commit = String(reader.SnapshotCommit)
                reader.dispose()
                assert.deepEqual(await inbox.Await(), [{ commit, concepts: [TodlNames.Element] }], 'the reopen is pushed as the root')
            }
            finally
            {
                push.dispose()
            }
        }, false)
    })

    test('reopened engine keeps pushing', async () =>
    {
        await PushFx.Run({}, async fx =>
        {
            const host = fx.Server.EnvironmentEngine()
            const inbox = new Inbox(await PushFx.Connect(fx))
            const first = await host.Engine()
            // a new external connector set reopens the engine (R25: the old one is disposed first)
            fx.Live(PushFx.ExtApp, PushFx.AppVersion, [PushFx.Ext])
            await host.Redeliver()
            assert.notEqual(await host.Engine(), first, 'the engine was reopened')
            await PushFx.Applied(fx, [{ op: AppWriteOpKind.Create, concept: PushFx.Account, fields: { [PushFx.Name]: PushFx.A } }])
            const commit = await PushFx.Commit(fx)
            // the reopen's root may arrive separately or share the write's window: wait for the write's own commit
            const pushed = await inbox.AwaitCommit(commit)
            assert.ok(pushed.concepts.includes(PushFx.Account), JSON.stringify(pushed))
        }, false)
    })

    test('dev tenants get no data/changed', async () =>
    {
        const packages = mkdtempSync(join(tmpdir(), PushFx.DevPrefix))
        const server = new PragmaticServer({ purpose: TenantPurpose.Development, packagesRoot: packages })
        try
        {
            assert.equal(ServerConnectionHandler.RuntimeAttachArgs(server).dataChanges, undefined)
            assert.throws(() => server.DataChanges())
        }
        finally
        {
            await server.Dispose()
            rmSync(packages, { recursive: true, force: true })
        }
    })
})
