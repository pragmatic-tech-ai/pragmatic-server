import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { Repository, Cardinality, toJSON, BlobPackageStore, StoragePackageSink, DataSourceKind, WriteOperationKind } from '@pragmatic-tech-ai/todl'
import type { PackageDocument, CompiledPackage, IDataSourceAdapter, ExternalFieldValue } from '@pragmatic-tech-ai/todl'
import type { ISecurityModelConfig, AccessContext } from '@pragmatic-tech-ai/todl-identity'
import { PrivilegeAction, OwnershipSourceKind } from '@pragmatic-tech-ai/todl-identity'
import { ShareSubjectKind, AssignStatus, InMemoryMessageSocket, PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AssignParams, AssignResultDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { PragmaticServer } from '../../../pragmatic-server.js'
import { TenantPurpose } from '../../../tenancy/tenant-purpose.js'
import { NodePlatform } from '../../../platform/node-platform.js'
import { BuiltinAdapterFactory } from '../../connectors/builtin-adapter-factory.js'
import { BuiltinBindings } from '../../connectors/builtin-bindings.js'
import { BuiltinStoreEngine } from '../../connectors/builtin-store-engine.js'
import { ServerConnectionHandler } from '../../server-connection-handler.js'
import type { PragmaticAppsRegistry } from '../../apps/pragmatic-apps-registry.js'
import { PpSecurityHarness } from './pp-security-harness.js'

class RecordAssignFixture
{
    private static readonly Id = 'shop'
    public static readonly Version = '1.0.0'
    private static readonly PkgPrefix = 'ras-pkgs-'
    private static readonly AppsPrefix = 'ras-apps-'
    private static readonly IdPrefix = 'ras-id-'
    private static readonly AppName = 'demo'
    private static readonly ManifestFile = 'application.json'
    private static readonly SourceSuffix = '.todl'
    private static readonly IdField = 'id'
    private static readonly DataDir = 'data'
    private static readonly Namespace = 'shop'
    private static readonly OwnerField = 'ownerid'
    private static readonly Label = 'label'
    private static readonly NoConnectors = 'no connectors'
    private static readonly ForeignOwner = 'someone-else'
    public static readonly Qualified = 'shop.Widget'
    public static readonly Principal = 'p1'
    public static readonly NewOwner = 'p2'
    public static readonly HiddenId = 'rec-hidden'
    public static readonly VisibleId = 'rec-visible'
    public static readonly IdentityError = /identity subsystem/

    private readonly packages = mkdtempSync(join(tmpdir(), RecordAssignFixture.PkgPrefix))
    private readonly apps = mkdtempSync(join(tmpdir(), RecordAssignFixture.AppsPrefix))
    private readonly identityRoot = mkdtempSync(join(tmpdir(), RecordAssignFixture.IdPrefix))
    private server: PragmaticServer | undefined
    private store: IDataSourceAdapter | undefined

    public static get Name(): string
    {
        return RecordAssignFixture.AppName
    }

    public static get NoConnectorsMessage(): string
    {
        return RecordAssignFixture.NoConnectors
    }

    public static get ForeignOwnerId(): string
    {
        return RecordAssignFixture.ForeignOwner
    }

    /** Boots a runtime server; identity is wired unless `identity` is false. */
    public async Setup(identity: boolean = true): Promise<PragmaticServer>
    {
        PpSecurityHarness.SetKey()
        const doc = toJSON(RecordAssignFixture.Repo()) as PackageDocument
        const pkg: CompiledPackage = {
            id: RecordAssignFixture.Id, version: RecordAssignFixture.Version, document: doc, fullDocument: doc,
            sources: [{ uri: RecordAssignFixture.Id + RecordAssignFixture.SourceSuffix, text: '' }], classes: [],
        }
        await new BlobPackageStore(new StoragePackageSink(new NodeFsStorage(this.packages))).persist(pkg)
        mkdirSync(join(this.apps, RecordAssignFixture.AppName))
        writeFileSync(join(this.apps, RecordAssignFixture.AppName, RecordAssignFixture.ManifestFile), JSON.stringify({
            name: RecordAssignFixture.AppName, version: RecordAssignFixture.Version,
            packages: [{ id: RecordAssignFixture.Id, version: RecordAssignFixture.Version }],
        }))
        this.server = new PragmaticServer({
            packagesRoot: this.packages, applicationsRoot: this.apps, purpose: TenantPurpose.Runtime,
            builtinStoreEngine: BuiltinStoreEngine.Document,
            identity: identity ? PpSecurityHarness.Identity(this.identityRoot) : undefined,
        })
        await this.server.Start()
        if (identity)
        {
            await PpSecurityHarness.Seed(this.server, RecordAssignFixture.Model())
        }
        await this.Put(RecordAssignFixture.VisibleId, PpSecurityHarness.SalesBu, RecordAssignFixture.Principal)
        await this.Put(RecordAssignFixture.HiddenId, PpSecurityHarness.RootBu, RecordAssignFixture.ForeignOwner)
        return this.server
    }

    public async GrantAssign(server: PragmaticServer, recordId: string): Promise<void>
    {
        await server.AppShareStore(RecordAssignFixture.AppName).Grant({
            concept: RecordAssignFixture.Qualified, recordId,
            subject: { kind: ShareSubjectKind.Principal, id: RecordAssignFixture.Principal }, rights: [PrivilegeAction.Assign],
        })
    }

    /** The stored owner column of a record. */
    public async OwnerOf(key: string): Promise<unknown>
    {
        const rows = await (await this.Store()).Query({
            Source: BuiltinBindings.CollectionFor(RecordAssignFixture.Qualified),
            Fields: [RecordAssignFixture.IdField, RecordAssignFixture.OwnerField],
        })
        return rows.find(r => r[RecordAssignFixture.IdField] === key)?.[RecordAssignFixture.OwnerField]
    }

    public static Params(id: string): AssignParams
    {
        return { concept: RecordAssignFixture.Qualified, id, owner: { kind: ShareSubjectKind.Principal, id: RecordAssignFixture.NewOwner }, owningBu: PpSecurityHarness.SalesBu }
    }

    public async Dispose(): Promise<void>
    {
        await this.store?.Dispose()
        await this.server?.Dispose()
        rmSync(this.packages, { recursive: true, force: true })
        rmSync(this.apps, { recursive: true, force: true })
        rmSync(this.identityRoot, { recursive: true, force: true })
        PpSecurityHarness.ClearKey()
    }

    private async Put(key: string, owningBu: string, owner: string): Promise<void>
    {
        const fields: Record<string, ExternalFieldValue> = {
            [PpSecurityHarness.OwningBuField]: owningBu, [RecordAssignFixture.OwnerField]: owner, [RecordAssignFixture.Label]: key,
        }
        const result = await (await this.Store()).Apply({
            Source: BuiltinBindings.CollectionFor(RecordAssignFixture.Qualified), IdKey: RecordAssignFixture.IdField,
            Operations: [{ Kind: WriteOperationKind.Upsert, Key: key, Fields: fields }],
        })
        assert.equal(result.Applied, 1)
    }

    private async Store(): Promise<IDataSourceAdapter>
    {
        if (this.store === undefined)
        {
            const factory = new BuiltinAdapterFactory((root, engine) => new NodePlatform().CreateAppDataStore(root, engine))
            this.store = await factory.Open({
                Kind: DataSourceKind.Builtin,
                Config: {
                    [BuiltinAdapterFactory.DataRootKey]: join(this.apps, RecordAssignFixture.AppName, RecordAssignFixture.DataDir),
                    [BuiltinAdapterFactory.EngineKey]: BuiltinStoreEngine.Document,
                },
            })
        }
        return this.store
    }

    /** BU-level Read only (no Assign role); the ownership rule adds an owner column so the concept is assignable. */
    private static Model(): ISecurityModelConfig
    {
        const base = PpSecurityHarness.BuSecurityModel(RecordAssignFixture.Principal)
        const target = (concept: string) => concept === PpSecurityHarness.Concept ? RecordAssignFixture.Qualified : concept
        return {
            ...base,
            ownershipRules: base.ownershipRules.map(r => ({
                ...r, concept: target(r.concept),
                owner: { kind: OwnershipSourceKind.FromField, value: RecordAssignFixture.OwnerField },
            })),
            roles: base.roles.map(r => ({ ...r, privileges: r.privileges.map(p => ({ ...p, concept: target(p.concept) })) })),
        }
    }

    private static Repo(): Repository
    {
        const repo = new Repository()
        repo.builder()
            .setNamespace(RecordAssignFixture.Namespace)
            .defineConcept(RecordAssignFixture.Qualified)
            .addField(RecordAssignFixture.Qualified, RecordAssignFixture.IdField, 'string', Cardinality.Optional)
            .addField(RecordAssignFixture.Qualified, PpSecurityHarness.OwningBuField, 'string', Cardinality.Optional)
            .addField(RecordAssignFixture.Qualified, RecordAssignFixture.OwnerField, 'string', Cardinality.Optional)
            .addField(RecordAssignFixture.Qualified, RecordAssignFixture.Label, 'string', Cardinality.Optional)
            .commit()
        return repo
    }
}

class AssignRecorder
{
    public received: { name: string; params: AssignParams } | undefined

    public async Provide(_c: AccessContext, name: string, params: AssignParams): Promise<AssignResultDto>
    {
        this.received = { name, params }
        return { status: AssignStatus.Applied }
    }
}

class DevelopmentServerStub
{
    constructor(public readonly server: PragmaticServer, private readonly root: string)
    {
    }

    public async Dispose(): Promise<void>
    {
        await this.server.Dispose()
        rmSync(this.root, { recursive: true, force: true })
    }
}

class HandlerFixture
{
    private static readonly PackagesPrefix = 'ras-hnd-'
    private static readonly DevPrefix = 'ras-dev-'
    private static readonly SampleId = 'r1'
    public static readonly UnboundError = /no application selected/i

    public static get RecordId(): string
    {
        return HandlerFixture.SampleId
    }

    public static async With(provider: ((c: AccessContext, name: string, p: AssignParams) => Promise<AssignResultDto>) | undefined, body: (client: PragmaticClient) => Promise<void>): Promise<void>
    {
        const packages = mkdtempSync(join(tmpdir(), HandlerFixture.PackagesPrefix))
        const server = new PragmaticServer({ packagesRoot: packages })
        await server.Start()
        const languageService = await server.LanguageService()
        const manager = await server.Manager()
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const applications = { List: async () => [], ApplicationFor: async (name: string) => ({ Manifest: { name, version: RecordAssignFixture.Version } }) } as unknown as PragmaticAppsRegistry
        const handler = ServerConnectionHandler.Attach(serverSocket, languageService, manager, PpSecurityHarness.Context(RecordAssignFixture.Principal), () => Promise.reject(new Error(RecordAssignFixture.NoConnectorsMessage)), ctx => server.Graph(ctx), undefined, undefined, undefined, undefined, undefined, undefined, TenantPurpose.Runtime, applications, undefined, undefined, undefined, undefined, undefined, provider)
        const client = PragmaticClient.CreateOverSocket(clientSocket)
        try
        {
            await body(client)
        }
        finally
        {
            await client.DisposeAsync()
            handler.Dispose()
            await (languageService as SolutionLanguageService).WhenIdle()
            await server.Dispose()
            rmSync(packages, { recursive: true, force: true })
        }
    }

    public static DevelopmentServer(): DevelopmentServerStub
    {
        const root = mkdtempSync(join(tmpdir(), HandlerFixture.DevPrefix))
        return new DevelopmentServerStub(new PragmaticServer({ packagesRoot: root }), root)
    }
}

test('an Assign-share holder reassigns an unreadable record end-to-end', async () =>
{
    const fx = new RecordAssignFixture()
    try
    {
        const server = await fx.Setup()
        const actor = PpSecurityHarness.Context(RecordAssignFixture.Principal)
        await fx.GrantAssign(server, RecordAssignFixture.HiddenId)
        assert.equal(await fx.OwnerOf(RecordAssignFixture.HiddenId), RecordAssignFixture.ForeignOwnerId)
        const result = await server.AssignForPragmaticApp(actor, RecordAssignFixture.Name, RecordAssignFixture.Params(RecordAssignFixture.HiddenId))
        assert.equal(result.status, AssignStatus.Applied)
        assert.equal(await fx.OwnerOf(RecordAssignFixture.HiddenId), RecordAssignFixture.NewOwner)
    }
    finally
    {
        await fx.Dispose()
    }
})

test('assign is denied without the Assign right and writes nothing', async () =>
{
    const fx = new RecordAssignFixture()
    try
    {
        const server = await fx.Setup()
        const actor = PpSecurityHarness.Context(RecordAssignFixture.Principal)
        const result = await server.AssignForPragmaticApp(actor, RecordAssignFixture.Name, RecordAssignFixture.Params(RecordAssignFixture.VisibleId))
        assert.equal(result.status, AssignStatus.Denied)
        assert.equal(await fx.OwnerOf(RecordAssignFixture.VisibleId), RecordAssignFixture.Principal)
    }
    finally
    {
        await fx.Dispose()
    }
})

test('assign requires an identity subsystem', async () =>
{
    const fx = new RecordAssignFixture()
    try
    {
        const server = await fx.Setup(false)
        await assert.rejects(() => server.AssignForPragmaticApp(PpSecurityHarness.Context(RecordAssignFixture.Principal), RecordAssignFixture.Name, RecordAssignFixture.Params(RecordAssignFixture.VisibleId)), RecordAssignFixture.IdentityError)
    }
    finally
    {
        await fx.Dispose()
    }
})

test('RuntimeAttachArgs returns a defined assignProvider only for a Runtime server', async () =>
{
    const fx = new RecordAssignFixture()
    const dev = HandlerFixture.DevelopmentServer()
    try
    {
        const runtime = await fx.Setup()
        assert.notEqual(ServerConnectionHandler.RuntimeAttachArgs(runtime).assignProvider, undefined)
        assert.equal(ServerConnectionHandler.RuntimeAttachArgs(dev.server).assignProvider, undefined)
    }
    finally
    {
        await dev.Dispose()
        await fx.Dispose()
    }
})

test('RunAssign forwards the bound app and params to the provider; unbound is rejected', async () =>
{
    const recorder = new AssignRecorder()
    const provider = (c: AccessContext, name: string, params: AssignParams): Promise<AssignResultDto> => recorder.Provide(c, name, params)
    await HandlerFixture.With(provider, async client =>
    {
        await assert.rejects(() => client.AssignRecord(RecordAssignFixture.Params(HandlerFixture.RecordId)), HandlerFixture.UnboundError)
        await client.OpenApplication(RecordAssignFixture.Name)
        const out = await client.AssignRecord(RecordAssignFixture.Params(HandlerFixture.RecordId))
        assert.equal(out.status, AssignStatus.Applied)
        assert.equal(recorder.received?.name, RecordAssignFixture.Name)
        assert.equal(recorder.received?.params.id, HandlerFixture.RecordId)
    })
})
