import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccessScope, StorageKind } from '@pragmatic-tech-ai/graph'
import type { CellValue } from '@pragmatic-tech-ai/graph'
import { BlobPackageStore, compilePackage, DataSourceAdapterCatalog, PackageKind, StoragePackageSink } from '@pragmatic-tech-ai/todl'
import type { CompiledPackage } from '@pragmatic-tech-ai/todl'
import { InMemoryMessageSocket, PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessContext, Grant, IdentityConfig, ResourceAuthorizationPolicy, ResourceKind, ResourceRef, Role, Tenant, TenantKind } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig, Principal } from '@pragmatic-tech-ai/todl-identity'
import { ServiceProvider } from '@pragmatic-tech-ai/todl-runtime'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { PragmaticServer } from '../../../pragmatic-server.js'
import { TenantPurpose } from '../../../tenancy/tenant-purpose.js'
import { PragmaticAppsRegistry } from '../../apps/pragmatic-apps-registry.js'
import { MemorySourceAdapter, MemorySourceAdapterFactory } from '../../engine/tests/memory-source-adapter.js'
import { ServerConnectionHandler } from '../../server-connection-handler.js'
import { EnvironmentDeliveries } from '../environment-deliveries.js'
import { EnvironmentEngineHost } from '../environment-engine-host.js'
import type { IEnvironmentDiagnostics, IEnvironmentHostTiming } from '../environment-engine-host.js'
import { PromoteRecordStore } from '../promote-record-store.js'

/** A package an app manifest or the promote record names. */
export type FixturePackageRef = { readonly id: string; readonly version: string }

/** One engine-stored node `Seed` writes: `Owner` defaults to the concept's home package (`catalog.HomeModels`). */
export type SeedRow = {
    readonly Concept: string
    readonly Id: string
    readonly Owner?: string
    readonly Properties?: Readonly<Record<string, CellValue>>
}

export interface IEnvironmentFixtureOptions
{
    /** Boot the identity subsystem (master key, tenant config); absent = no identity (Default Allow). */
    readonly Identity?: boolean
    /** With identity: the tenant security model saved into the tenant config after boot. */
    readonly SecurityModel?: ISecurityModelConfig
}

/**
 * A runtime tenant on disk for environment-engine tests (server-own, Task 5): `<root>/<TenantId>/{packages,
 * applications,graphs,identity}` as TenantRegistry lays it out. `Package` compiles TODL with `compilePackage` into
 * `packages/`; `Live` writes an app manifest and its `live` pointer; `Promote` writes the promote record; `Start` builds
 * a Runtime `PragmaticServer` (identity optional) whose adapter catalog serves the SQL kind from `Source` (a
 * MemorySourceAdapter), so any `kind = sql` datasource is an external binding over it; `Host` builds a standalone
 * EnvironmentEngineHost over the same directories (for tests that need its seams); `Seed` writes engine-stored nodes
 * through an `AccessScope.System` transaction; `Connect` attaches a `PragmaticClient` over an in-memory socket pair.
 * No access-policy files are written (amendment A5). `Dispose` removes the whole temp root.
 */
export class EnvironmentFixture
{
    public static readonly TenantId = 'env1'
    public static readonly KeyEnv = 'PS_ENVIRONMENT_FIXTURE_KEY'
    private static readonly DisplayName = 'Environment One'
    private static readonly RootPrefix = 'ps-env-'
    private static readonly PackagesDir = 'packages'
    private static readonly ApplicationsDir = 'applications'
    private static readonly GraphsDir = 'graphs'
    private static readonly IdentityDir = 'identity'
    private static readonly ManifestFile = 'application.json'
    private static readonly LivePointerFile = 'live'
    private static readonly SourceSuffix = '.todl'
    private static readonly NotStartedMessage = 'the environment fixture has not been started'
    private static readonly NotSeededMessage = 'tenant config was not seeded on boot'
    private static readonly NoConnectorsMessage = 'connectors are not available on a runtime tenant'

    public readonly Root = mkdtempSync(join(tmpdir(), EnvironmentFixture.RootPrefix))
    public readonly TenantDir = join(this.Root, EnvironmentFixture.TenantId)
    public readonly PackagesDir = join(this.TenantDir, EnvironmentFixture.PackagesDir)
    public readonly AppsDir = join(this.TenantDir, EnvironmentFixture.ApplicationsDir)
    public readonly GraphsDir = join(this.TenantDir, EnvironmentFixture.GraphsDir)
    public readonly IdentityDir = join(this.TenantDir, EnvironmentFixture.IdentityDir)
    /** The engine store path the server's environment host uses. */
    public readonly StorePath = join(this.GraphsDir, EnvironmentEngineHost.StoreDir)
    /** Serves every SQL datasource of the tenant (over `adapter`, default a fresh MemorySourceAdapter). */
    public readonly Source: MemorySourceAdapterFactory

    private server: PragmaticServer | undefined
    private readonly hosts: EnvironmentEngineHost[] = []
    private readonly clients: { Client: PragmaticClient; Handler: ServerConnectionHandler }[] = []

    public constructor(adapter: MemorySourceAdapter = new MemorySourceAdapter())
    {
        this.Source = new MemorySourceAdapterFactory(adapter)
        for (const dir of [this.PackagesDir, this.AppsDir, this.GraphsDir, this.IdentityDir]) mkdirSync(dir, { recursive: true })
    }

    public get Server(): PragmaticServer
    {
        if (this.server === undefined) throw new Error(EnvironmentFixture.NotStartedMessage)
        return this.server
    }

    /** Compiles `todl` as package `id@version` (over the full documents of `dependsOn`) and stores it in `packages/`. */
    public async Package(id: string, version: string, todl: string, dependsOn: readonly CompiledPackage[] = []): Promise<CompiledPackage>
    {
        const outcome = compilePackage(dependsOn.map(dependency => dependency.fullDocument), [{ uri: id + EnvironmentFixture.SourceSuffix, text: todl }], { id, version },
            dependsOn.map(dependency => ({ kind: PackageKind.Library, id: dependency.id, version: dependency.version })))
        assert.ok(outcome.ok, JSON.stringify(outcome.errors))
        await new BlobPackageStore(new StoragePackageSink(new NodeFsStorage(this.PackagesDir))).persist(outcome.package!)
        return outcome.package!
    }

    /** Writes `applications/<app>/<version>/application.json` and makes that version live (`<app>/live`). */
    public Live(app: string, version: string, packages: readonly FixturePackageRef[]): void
    {
        mkdirSync(join(this.AppsDir, app, version), { recursive: true })
        const manifest = { name: app, version, packages: packages.map(ref => ({ id: ref.id, version: ref.version })) }
        writeFileSync(join(this.AppsDir, app, version, EnvironmentFixture.ManifestFile), JSON.stringify(manifest))
        writeFileSync(join(this.AppsDir, app, EnvironmentFixture.LivePointerFile), version)
    }

    /** Sets a fresh master key in `KeyEnv` (as `Start` does with identity) and returns its reference, for a TenantRegistry over `Root`. */
    public MasterKey(): { base64Env: string }
    {
        process.env[EnvironmentFixture.KeyEnv] = randomBytes(32).toString('base64')
        return { base64Env: EnvironmentFixture.KeyEnv }
    }

    /** Writes the promote record (`graphs/loaded-graph.json`). */
    public Promote(name: string, packages: readonly FixturePackageRef[]): Promise<void>
    {
        return this.PromoteRecords().Save({ name, packages: packages.map(ref => ({ id: ref.id, version: ref.version })), promotedAt: new Date().toISOString() })
    }

    public Deliveries(): EnvironmentDeliveries
    {
        return new EnvironmentDeliveries(new PragmaticAppsRegistry(new NodeFsStorage(this.AppsDir)), this.PromoteRecords())
    }

    /** Builds and starts the Runtime server of the tenant. */
    public async Start(options: IEnvironmentFixtureOptions = {}): Promise<PragmaticServer>
    {
        if (options.Identity === true) this.MasterKey()
        this.server = new PragmaticServer({
            purpose: TenantPurpose.Runtime,
            packagesRoot: this.PackagesDir,
            applicationsRoot: this.AppsDir,
            graphsRoot: this.GraphsDir,
            adapterFactories: [this.Source],
            ...(options.Identity === true
                ? { identity: { identityRoot: this.IdentityDir, masterKey: { base64Env: EnvironmentFixture.KeyEnv }, tenant: { id: EnvironmentFixture.TenantId, displayName: EnvironmentFixture.DisplayName } } }
                : {}),
        })
        await this.server.Start()
        if (options.SecurityModel !== undefined) await this.SaveSecurityModel(options.SecurityModel)
        return this.server
    }

    /**
     * A standalone environment host over the fixture's directories (not the server's): its own services resolving an
     * adapter catalog that serves `Source`, the store at `StorePath` unless `kind` is Memory, and `packages` (default:
     * `packages/`) as the package storage.
     */
    public Host(diagnostics?: IEnvironmentDiagnostics, timing?: IEnvironmentHostTiming, packages: IStorage = new NodeFsStorage(this.PackagesDir), kind: StorageKind = StorageKind.Lmdb): EnvironmentEngineHost
    {
        const services = new ServiceProvider()
        services.registerInstance(DataSourceAdapterCatalog.ServiceKey, new DataSourceAdapterCatalog().Register(this.Source))
        const host = new EnvironmentEngineHost(this.Deliveries(), packages, services, { Kind: kind, Path: this.StorePath }, diagnostics, timing)
        this.hosts.push(host)
        return host
    }

    /**
     * Writes `rows` as engine-stored nodes in one `AccessScope.System` transaction on `host` (default: the server's
     * environment engine); returns the commit.
     */
    public async Seed(rows: readonly SeedRow[], host: EnvironmentEngineHost = this.Server.EnvironmentEngine()): Promise<bigint>
    {
        const homes = (await host.Snapshot()).Catalog.HomeModels
        const transaction = await (await host.Engine()).Begin(AccessScope.System)
        for (const row of rows)
        {
            const owner = row.Owner ?? homes.get(row.Concept)
            transaction.CreateNode(row.Id, row.Concept, owner === undefined ? undefined : { Owner: owner })
            for (const [member, value] of Object.entries(row.Properties ?? {})) transaction.SetProperty(row.Id, member, value)
        }
        return transaction.Commit()
    }

    /** A client attached to the started server as `principal` (an Owner grant on the tenant: the gate admits it; the scope decides). */
    public async Connect(principal: Principal): Promise<PragmaticClient>
    {
        const server = this.Server
        const tenant = new Tenant(EnvironmentFixture.TenantId, TenantKind.SelfHosted, EnvironmentFixture.DisplayName)
        const grants = [new Grant(principal.Id, Role.Owner, new ResourceRef(ResourceKind.Tenant, EnvironmentFixture.TenantId, []))]
        const context = new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
        const runtime = ServerConnectionHandler.RuntimeAttachArgs(server)
        const development = ServerConnectionHandler.DevelopmentAttachArgs(server)
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, await server.LanguageService(), await server.Manager(), context,
            () => Promise.reject(new Error(EnvironmentFixture.NoConnectorsMessage)), development.devCypher, undefined, undefined, undefined, undefined, undefined, undefined,
            server.Purpose(), runtime.applications, runtime.appGraphProvider, runtime.appWriteProvider, runtime.shareProvider, runtime.unshareProvider, runtime.listSharesProvider,
            runtime.assignProvider, undefined, await server.FieldReadMaskSource(), ctx => server.ConnectorReadAuthorizationFor(ctx),
            (ctx, target) => server.ConnectorWriteAuthorizationFor(ctx, target), (ctx, id, request) => server.ExecuteCypher(ctx, id, request), runtime.deployProvider,
            development.devGraphService, runtime.environmentGraphHost, development.devModelView, await server.DepthFilterSource())
        const client = PragmaticClient.CreateOverSocket(clientSocket)
        this.clients.push({ Client: client, Handler: handler })
        return client
    }

    /** Closes every client, host and the server, then removes the temp root. */
    public async Dispose(): Promise<void>
    {
        try
        {
            for (const { Client, Handler } of this.clients.splice(0))
            {
                await Client.DisposeAsync()
                Handler.Dispose()
            }
            for (const host of this.hosts.splice(0)) await host.dispose()
            await this.server?.Dispose()
        }
        finally
        {
            delete process.env[EnvironmentFixture.KeyEnv]
            rmSync(this.Root, { recursive: true, force: true })
        }
    }

    private PromoteRecords(): PromoteRecordStore
    {
        return new PromoteRecordStore(new NodeFsStorage(this.GraphsDir))
    }

    private async SaveSecurityModel(model: ISecurityModelConfig): Promise<void>
    {
        const store = await this.Server.TenantConfigStore()
        const seeded = await store.Get(EnvironmentFixture.TenantId)
        assert.ok(seeded !== null, EnvironmentFixture.NotSeededMessage)
        await store.Save(EnvironmentFixture.TenantId, new IdentityConfig(seeded.PackId, seeded.DelegationDepth, seeded.ProviderSettings, seeded.GroupRoleMap, seeded.ClaimsMapping, model))
    }
}
