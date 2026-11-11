import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AccessScope, Cypher, StorageKind } from '@pragmatic-tech-ai/graph'
import type { ConnectorError, GraphEngine, IGraphEngineOptions } from '@pragmatic-tech-ai/graph'
import { StoragePackageSource } from '@pragmatic-tech-ai/todl'
import { DeliveryChannel, EnvironmentCatalogComposer, EnvironmentCatalogError } from '@pragmatic-tech-ai/todl/engine'
import { AppWriteStatus, ErrorCodes, ResponseError } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ContributedPackageDto, CypherAppDeployParamsDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { AppIngestService } from '../../apps/app-ingest-service.js'
import { EnvironmentEngineHost, EnvironmentUpgradeFailedError } from '../environment-engine-host.js'
import type { IEnvironmentDiagnostics } from '../environment-engine-host.js'
import { EnvironmentFixture } from './environment-fixture.js'
import type { FixturePackageRef } from './environment-fixture.js'

/** Records the upgrade failures; the other diagnostics are ignored. */
class UpgradeDiagnostics implements IEnvironmentDiagnostics
{
    public readonly Upgrades: unknown[] = []

    public UpgradeFailed(error: unknown): void
    {
        this.Upgrades.push(error)
    }

    public ChangedHandlerFailed(): void
    {
    }

    public RevertFailed(_error: ConnectorError): void
    {
    }

    public OpenRetried(): void
    {
    }

    public DrainUnsettled(): void
    {
    }
}

/** A host whose next engine open fails (`FailNextOpen`): a reopen after deploy whose store cannot be opened. */
class FailingOpenHost extends EnvironmentEngineHost
{
    private static readonly FailureMessage = 'the store could not be opened'
    public FailNextOpen = false

    protected override OpenEngine(options: IGraphEngineOptions): Promise<GraphEngine>
    {
        if (!this.FailNextOpen) return super.OpenEngine(options)
        this.FailNextOpen = false
        return Promise.reject(new Error(FailingOpenHost.FailureMessage))
    }
}

class DeliveryFx
{
    public static readonly Crm = { id: 'crm', version: '1.0.0' }
    public static readonly CrmMajor = { id: 'crm', version: '2.0.0' }
    public static readonly Notes = { id: 'notes', version: '1.0.0' }
    public static readonly Ext = { id: 'ext', version: '1.0.0' }
    public static readonly Ref = { id: 'ref', version: '1.0.0' }
    public static readonly V1 = '1.0.0'
    public static readonly V2 = '2.0.0'
    public static readonly CrmApp = 'crm-app'
    public static readonly NotesApp = 'notes-app'
    public static readonly OtherApp = 'other-app'
    public static readonly ExtApp = 'ext-app'
    public static readonly RefSet = 'ref-set'
    public static readonly NotesSet = 'notes-set'
    public static readonly Account = 'crm.Account'
    public static readonly Note = 'notes.Note'
    public static readonly Code = 'ref.Code'
    public static readonly Customer = 'ext.Customer'
    public static readonly AccountId = 'acc-1'
    public static readonly NoteId = 'note-1'
    public static readonly Acme = 'Acme'
    public static readonly NameMember = 'name'
    public static readonly ModelFile = 'model.json'
    public static readonly LivePointer = 'live'
    public static readonly EngineField = 'environmentEngine'
    public static readonly ExtSet = 'ext-set'
    public static readonly Entry = 'index.html'
    public static readonly Page = '<html></html>'
    public static readonly Base64 = 'base64'
    public static readonly Accounts = 'MATCH (a:`crm.Account`) RETURN a.name AS name'
    public static readonly CrmTodl = 'namespace crm {\n  concept Account { name : string?; }\n  model Crm : crm { }\n}\n'
    public static readonly CrmMajorTodl = 'namespace crm {\n  concept Account { name : string?; code : string?; }\n  model Crm : crm { }\n}\n'
    public static readonly NotesTodl = 'namespace notes {\n  concept Note { text : string?; }\n  model Notes : notes { }\n}\n'
    public static readonly RefTodl = 'namespace ref {\n  concept Code { name : string?; }\n  model Ref : ref { }\n}\n'
    public static readonly ExtTodl = 'namespace ext {\n  concept Customer { name : string?; }\n  datasource src { kind = sql; connection = "ext-db"; }\n  model Ext : ext { connect src; populate Customer key cust_id { name = "nm"; } }\n}\n'

    /** The fixture with every package compiled and the Runtime server started. */
    public static async Run(body: (fx: EnvironmentFixture) => Promise<void>): Promise<void>
    {
        const fx = new EnvironmentFixture()
        try
        {
            await fx.Package(DeliveryFx.Crm.id, DeliveryFx.Crm.version, DeliveryFx.CrmTodl)
            await fx.Package(DeliveryFx.CrmMajor.id, DeliveryFx.CrmMajor.version, DeliveryFx.CrmMajorTodl)
            await fx.Package(DeliveryFx.Notes.id, DeliveryFx.Notes.version, DeliveryFx.NotesTodl)
            await fx.Package(DeliveryFx.Ref.id, DeliveryFx.Ref.version, DeliveryFx.RefTodl)
            await fx.Package(DeliveryFx.Ext.id, DeliveryFx.Ext.version, DeliveryFx.ExtTodl)
            await fx.Start()
            await body(fx)
        }
        finally
        {
            await fx.Dispose()
        }
    }

    /** The stored compiled package `ref` as a wire payload (byte-identical, so ingest skips rewriting it). */
    public static Contributed(fx: EnvironmentFixture, ref: FixturePackageRef): ContributedPackageDto
    {
        return { id: ref.id, version: ref.version, modelJson: readFileSync(join(fx.PackagesDir, ref.id, ref.version, DeliveryFx.ModelFile), 'utf8') }
    }

    /** Deploy params for `app@version` delivering `refs` (a one-file UI). */
    public static Params(fx: EnvironmentFixture, app: string, version: string, refs: readonly FixturePackageRef[]): CypherAppDeployParamsDto
    {
        return {
            appName: app,
            appVersion: version,
            packages: refs.map(ref => DeliveryFx.Contributed(fx, ref)),
            uiBundle: [{ path: DeliveryFx.Entry, contentBase64: Buffer.from(DeliveryFx.Page).toString(DeliveryFx.Base64) }],
            manifest: { name: app, version, packages: refs.map(ref => ({ id: ref.id, version: ref.version })), ui: { entry: DeliveryFx.Entry, assets: [] } },
        }
    }

    public static async Deploy(fx: EnvironmentFixture, app: string, version: string, refs: readonly FixturePackageRef[]): Promise<void>
    {
        const result = await fx.Server.DeployApplication(DeliveryFx.Params(fx, app, version, refs))
        assert.equal(result.status, AppWriteStatus.Applied, result.reason)
    }

    /**
     * Installs `host` as the server's environment engine (the memoized private field `EnvironmentEngine()` returns), so
     * a server endpoint runs against a host whose opens a test can fail. The fixture disposes it.
     */
    public static Install(fx: EnvironmentFixture, host: EnvironmentEngineHost): void
    {
        (fx.Server as unknown as Record<string, EnvironmentEngineHost>)[DeliveryFx.EngineField] = fx.Track(host)
    }

    public static async Definitions(host: EnvironmentEngineHost): Promise<string[]>
    {
        return (await host.Description()).Definitions.map(definition => definition.Name)
    }

    public static async ConceptOf(host: EnvironmentEngineHost, id: string): Promise<string | undefined>
    {
        const reader = await (await host.Engine()).BeginRead(AccessScope.System)
        try
        {
            return await reader.ConceptOf(id)
        }
        finally
        {
            reader.dispose()
        }
    }

    public static async Names(host: EnvironmentEngineHost): Promise<unknown[]>
    {
        const result = await new Cypher.CypherEngine(await host.Engine()).Execute(AccessScope.System, DeliveryFx.Accounts)
        return result.Rows.map(row => (row[0] as Cypher.ScalarValue).Value)
    }
}

describe('environment delivery (ruling S4)', () =>
{
    test('deploy upgrades the environment in place', async () =>
    {
        await DeliveryFx.Run(async fx =>
        {
            await DeliveryFx.Deploy(fx, DeliveryFx.CrmApp, DeliveryFx.V1, [DeliveryFx.Crm])
            const host = fx.Server.EnvironmentEngine()
            await fx.Seed([{ Concept: DeliveryFx.Account, Id: DeliveryFx.AccountId, Properties: { [DeliveryFx.NameMember]: DeliveryFx.Acme } }])
            const engine = await host.Engine()
            await DeliveryFx.Deploy(fx, DeliveryFx.NotesApp, DeliveryFx.V1, [DeliveryFx.Notes])
            assert.equal(await host.Engine(), engine, 'upgraded in place, not reopened')
            const definitions = await DeliveryFx.Definitions(host)
            assert.ok(definitions.includes(DeliveryFx.Account))
            assert.ok(definitions.includes(DeliveryFx.Note))
            assert.deepEqual(await DeliveryFx.Names(host), [DeliveryFx.Acme], 'the first app keeps its data')
        })
    })

    test('redeploy without a package discards its data', async () =>
    {
        await DeliveryFx.Run(async fx =>
        {
            await DeliveryFx.Deploy(fx, DeliveryFx.CrmApp, DeliveryFx.V1, [DeliveryFx.Crm, DeliveryFx.Notes])
            const host = fx.Server.EnvironmentEngine()
            await fx.Seed([{ Concept: DeliveryFx.Note, Id: DeliveryFx.NoteId }])
            assert.equal(await DeliveryFx.ConceptOf(host, DeliveryFx.NoteId), DeliveryFx.Note)
            await DeliveryFx.Deploy(fx, DeliveryFx.CrmApp, DeliveryFx.V2, [DeliveryFx.Crm])
            assert.equal((await DeliveryFx.Definitions(host)).includes(DeliveryFx.Note), false)
            assert.equal(await DeliveryFx.ConceptOf(host, DeliveryFx.NoteId), undefined, 'the dropped package takes its nodes with it (spec 4.3)')
        })
    })

    test('package still delivered by another app keeps its data', async () =>
    {
        await DeliveryFx.Run(async fx =>
        {
            await DeliveryFx.Deploy(fx, DeliveryFx.CrmApp, DeliveryFx.V1, [DeliveryFx.Crm, DeliveryFx.Notes])
            await DeliveryFx.Deploy(fx, DeliveryFx.NotesApp, DeliveryFx.V1, [DeliveryFx.Notes])
            const host = fx.Server.EnvironmentEngine()
            await fx.Seed([{ Concept: DeliveryFx.Note, Id: DeliveryFx.NoteId }])
            await DeliveryFx.Deploy(fx, DeliveryFx.CrmApp, DeliveryFx.V2, [DeliveryFx.Crm])
            assert.ok((await DeliveryFx.Definitions(host)).includes(DeliveryFx.Note))
            assert.equal(await DeliveryFx.ConceptOf(host, DeliveryFx.NoteId), DeliveryFx.Note, 'notes is still delivered by notes-app')
        })
    })

    test('incompatible deploy is invalid and changes nothing', async () =>
    {
        await DeliveryFx.Run(async fx =>
        {
            await DeliveryFx.Deploy(fx, DeliveryFx.CrmApp, DeliveryFx.V1, [DeliveryFx.Crm])
            const host = fx.Server.EnvironmentEngine()
            const engine = await host.Engine()
            const version = engine.SchemaVersion
            const result = await fx.Server.DeployApplication(DeliveryFx.Params(fx, DeliveryFx.OtherApp, DeliveryFx.V1, [DeliveryFx.CrmMajor]))
            const expected = await EnvironmentCatalogComposer.Compose({
                Deliveries: [
                    { Channel: DeliveryChannel.Deploy, Name: DeliveryFx.CrmApp, Packages: [{ model: DeliveryFx.Crm.id, version: DeliveryFx.Crm.version }] },
                    { Channel: DeliveryChannel.Deploy, Name: DeliveryFx.OtherApp, Packages: [{ model: DeliveryFx.CrmMajor.id, version: DeliveryFx.CrmMajor.version }] },
                ],
                Packages: new StoragePackageSource(new NodeFsStorage(fx.PackagesDir)),
            }).then(() => undefined, (error: unknown) => (error as EnvironmentCatalogError).message)
            assert.equal(result.status, AppWriteStatus.Invalid)
            assert.equal(result.reason, expected)
            for (const part of [DeliveryFx.Crm.id, DeliveryFx.Crm.version, DeliveryFx.CrmMajor.version, DeliveryFx.CrmApp, DeliveryFx.OtherApp]) assert.ok(result.reason?.includes(part), part)
            assert.equal(existsSync(join(fx.AppsDir, DeliveryFx.OtherApp, DeliveryFx.LivePointer)), false, 'the live pointer is not written')
            const current = await host.Engine()
            assert.equal(current, engine, 'not reopened')
            assert.equal(current.SchemaVersion, version, 'the engine is unchanged')
        })
    })

    test('promote joins the union', async () =>
    {
        await DeliveryFx.Run(async fx =>
        {
            await DeliveryFx.Deploy(fx, DeliveryFx.CrmApp, DeliveryFx.V1, [DeliveryFx.Crm])
            const host = fx.Server.EnvironmentEngine()
            await host.Engine()
            const record = await fx.Server.LoadEnvironmentGraph({ graphName: DeliveryFx.RefSet, packages: [DeliveryFx.Contributed(fx, DeliveryFx.Ref)] })
            assert.equal(record.name, DeliveryFx.RefSet)
            assert.deepEqual(record.packages, [DeliveryFx.Ref])
            let definitions = await DeliveryFx.Definitions(host)
            assert.ok(definitions.includes(DeliveryFx.Code) && definitions.includes(DeliveryFx.Account))
            assert.deepEqual(await fx.Server.LoadedGraph(), record)
            // re-promote replaces the promote set only
            const second = await fx.Server.LoadEnvironmentGraph({ graphName: DeliveryFx.NotesSet, packages: [DeliveryFx.Contributed(fx, DeliveryFx.Notes)] })
            definitions = await DeliveryFx.Definitions(host)
            assert.ok(definitions.includes(DeliveryFx.Note) && definitions.includes(DeliveryFx.Account))
            assert.equal(definitions.includes(DeliveryFx.Code), false)
            assert.deepEqual(await fx.Server.LoadedGraph(), second)
            // an incompatible promote is InvalidParams and keeps the record
            await assert.rejects(fx.Server.LoadEnvironmentGraph({ graphName: DeliveryFx.RefSet, packages: [DeliveryFx.Contributed(fx, DeliveryFx.CrmMajor)] }),
                (error: unknown) => error instanceof ResponseError && error.code === ErrorCodes.InvalidParams && error.message.includes(DeliveryFx.CrmMajor.version))
            assert.deepEqual(await fx.Server.LoadedGraph(), second)
        })
    })

    test('concurrent deploys are serialized and both land', async () =>
    {
        await DeliveryFx.Run(async fx =>
        {
            const host = fx.Server.EnvironmentEngine()
            await host.Engine()
            const results = await Promise.all([
                fx.Server.DeployApplication(DeliveryFx.Params(fx, DeliveryFx.CrmApp, DeliveryFx.V1, [DeliveryFx.Crm])),
                fx.Server.DeployApplication(DeliveryFx.Params(fx, DeliveryFx.NotesApp, DeliveryFx.V1, [DeliveryFx.Notes])),
            ])
            assert.deepEqual(results.map(result => result.status), [AppWriteStatus.Applied, AppWriteStatus.Applied])
            assert.deepEqual((await fx.Server.Applications().List()).map(app => app.name).sort(), [DeliveryFx.CrmApp, DeliveryFx.NotesApp])
            const definitions = await DeliveryFx.Definitions(host)
            assert.ok(definitions.includes(DeliveryFx.Account) && definitions.includes(DeliveryFx.Note))
            assert.deepEqual((await host.Snapshot()).Deliveries.map(delivery => delivery.Name), [DeliveryFx.CrmApp, DeliveryFx.NotesApp])
        })
    })

    test('upgrade failure after deploy reports failed and retries', async () =>
    {
        await DeliveryFx.Run(async fx =>
        {
            fx.Live(DeliveryFx.CrmApp, DeliveryFx.V1, [DeliveryFx.Crm])
            const diagnostics = new UpgradeDiagnostics()
            const packages = new NodeFsStorage(fx.PackagesDir)
            const host = fx.Track(new FailingOpenHost(fx.Deliveries(), packages, fx.Services(), { Kind: StorageKind.Lmdb, Path: join(fx.Root, EnvironmentEngineHost.StoreDir) }, diagnostics))
            await host.Engine()
            const ingest = new AppIngestService(packages, new NodeFsStorage(fx.AppsDir), host)
            // ext brings a new connector: the redelivery reopens, and that open fails
            host.FailNextOpen = true
            const result = await ingest.Ingest(DeliveryFx.Params(fx, DeliveryFx.ExtApp, DeliveryFx.V1, [DeliveryFx.Ext]))
            assert.equal(result.status, AppWriteStatus.Failed)
            assert.equal(result.reason, EnvironmentUpgradeFailedError.Reason)
            assert.equal(diagnostics.Upgrades.length, 1)
            assert.equal(readFileSync(join(fx.AppsDir, DeliveryFx.ExtApp, DeliveryFx.LivePointer), 'utf8'), DeliveryFx.V1, 'the deploy landed')
            assert.ok((await DeliveryFx.Definitions(host)).includes(DeliveryFx.Customer), 'the next use retries and sees the app')
        })
    })

    test('upgrade failure after promote is InternalError and retries', async () =>
    {
        await DeliveryFx.Run(async fx =>
        {
            fx.Live(DeliveryFx.CrmApp, DeliveryFx.V1, [DeliveryFx.Crm])
            const diagnostics = new UpgradeDiagnostics()
            const host = new FailingOpenHost(fx.Deliveries(), new NodeFsStorage(fx.PackagesDir), fx.Services(), { Kind: StorageKind.Lmdb, Path: fx.StorePath }, diagnostics)
            DeliveryFx.Install(fx, host)
            await host.Engine()
            // ext brings a new connector: the redelivery reopens, and that open fails
            host.FailNextOpen = true
            await assert.rejects(fx.Server.LoadEnvironmentGraph({ graphName: DeliveryFx.ExtSet, packages: [DeliveryFx.Contributed(fx, DeliveryFx.Ext)] }),
                (error: unknown) => error instanceof ResponseError && error.code === ErrorCodes.InternalError && error.message === EnvironmentUpgradeFailedError.PromoteReason)
            assert.equal(diagnostics.Upgrades.length, 1)
            assert.equal((await fx.Server.LoadedGraph())?.name, DeliveryFx.ExtSet, 'the promote record landed')
            assert.ok((await DeliveryFx.Definitions(host)).includes(DeliveryFx.Customer), 'the next use retries and sees the promote set')
        })
    })
})
