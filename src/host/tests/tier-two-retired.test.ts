import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, PragmaticClient, AppWriteOpKind, AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { compilePackage, BlobPackageStore, StoragePackageSink, type SolutionManagerService } from '@pragmatic-tech-ai/todl'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { AccessLevel, PrivilegeAction, OwnershipSourceKind } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../pragmatic-server.js'
import { TenantPurpose } from '../../tenancy/tenant-purpose.js'
import { BuiltinStoreEngine } from '../connectors/builtin-store-engine.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { PpSecurityHarness } from '../cypher/tests/pp-security-harness.js'

/*
 * Tier 2 (per-app access policy files, TODL model policies, app-private concept governance) is retired: only the
 * tenant security model (tier 1) decides runtime and dev visibility.
 */

/** One wire connection a fixture owns: the client and the handler it talks to, disposed together (dispose resolves once torn down). */
class WireConnection implements IDisposable
{
    public constructor(public readonly Client: PragmaticClient, private readonly handler: ServerConnectionHandler)
    {
    }

    public async dispose(): Promise<void>
    {
        await this.Client.DisposeAsync()
        this.handler.Dispose()
    }
}

/** One development server with an opened solution and one connection to it, and the temp dirs it owns (dispose resolves once torn down). */
class DevSession implements IDisposable
{
    public constructor(
        public readonly Connection: WireConnection,
        private readonly server: PragmaticServer,
        private readonly language: SolutionLanguageService,
        private readonly manager: SolutionManagerService,
        private readonly dirs: readonly string[])
    {
    }

    public async dispose(): Promise<void>
    {
        await this.Connection.dispose()
        await this.language.WhenIdle()
        await this.manager.CloseSolution()
        await this.server.Dispose()
        for (const dir of this.dirs)
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }
}

/**
 * A runtime tenant with identity: app `crm` binds packages crm (crm.Account, governed) and notes (notes.Note, NOT
 * governed). Its data/write still runs on the legacy app graph (Task 9 moves it); runtime reads are the environment
 * engine's (environment-scope-rules.test.ts pins that a retired access-policy.json changes nothing).
 */
class RuntimeTierFixture
{
    public static readonly Reader = 'p1'
    public static readonly Note = 'notes.Note'
    private static readonly AppName = 'crm'
    private static readonly Version = '1.0.0'
    private static readonly Account = 'crm.Account'
    private static readonly CrmPkg = 'crm'
    private static readonly NotesPkg = 'notes'
    private static readonly ManifestFile = 'application.json'
    private static readonly ReaderRole = 'reader'
    private static readonly ReaderRoleName = 'Reader'
    private static readonly RootName = 'Root'
    private static readonly SalesName = 'Sales'
    private static readonly NoteLabel = 'draft'
    private static readonly PackagesPrefix = 'tier2-pkgs-'
    private static readonly AppsPrefix = 'tier2-apps-'
    private static readonly IdentityPrefix = 'tier2-id-'
    private static readonly CrmTodl = 'namespace crm { concept Account { owningBu : string; } model Crm : crm { annotate entrypoint { } Account a1 { label = "acme"; owningBu = "sales"; } } }'
    private static readonly NotesTodl = 'namespace notes { concept Note { } model Notes : notes { annotate entrypoint { } Note n1 { label = "hello"; } } }'

    private readonly packages = mkdtempSync(join(tmpdir(), RuntimeTierFixture.PackagesPrefix))
    private readonly apps = mkdtempSync(join(tmpdir(), RuntimeTierFixture.AppsPrefix))
    private readonly identityRoot = mkdtempSync(join(tmpdir(), RuntimeTierFixture.IdentityPrefix))
    private server: PragmaticServer | undefined

    public static async Run(body: (fx: RuntimeTierFixture) => Promise<void>): Promise<void>
    {
        const fx = new RuntimeTierFixture()
        try
        {
            await fx.Setup()
            await body(fx)
        }
        finally
        {
            await fx.Dispose()
        }
    }

    public CreateNote(principal: string): ReturnType<PragmaticServer['WriteForPragmaticApp']>
    {
        return this.server!.WriteForPragmaticApp(PpSecurityHarness.Context(principal), RuntimeTierFixture.AppName,
            [{ op: AppWriteOpKind.Create, concept: RuntimeTierFixture.Note, fields: { label: RuntimeTierFixture.NoteLabel } }])
    }

    private async Setup(): Promise<void>
    {
        PpSecurityHarness.SetKey()
        await this.Publish(RuntimeTierFixture.CrmPkg, RuntimeTierFixture.CrmTodl)
        await this.Publish(RuntimeTierFixture.NotesPkg, RuntimeTierFixture.NotesTodl)
        mkdirSync(join(this.apps, RuntimeTierFixture.AppName))
        writeFileSync(join(this.apps, RuntimeTierFixture.AppName, RuntimeTierFixture.ManifestFile), JSON.stringify({
            name: RuntimeTierFixture.AppName, version: RuntimeTierFixture.Version,
            packages: [{ id: RuntimeTierFixture.CrmPkg, version: RuntimeTierFixture.Version }, { id: RuntimeTierFixture.NotesPkg, version: RuntimeTierFixture.Version }],
        }))
        this.server = new PragmaticServer({
            packagesRoot: this.packages, applicationsRoot: this.apps, purpose: TenantPurpose.Runtime,
            builtinStoreEngine: BuiltinStoreEngine.Document, identity: PpSecurityHarness.Identity(this.identityRoot),
        })
        await this.server.Start()
        await PpSecurityHarness.Seed(this.server, RuntimeTierFixture.Model())
    }

    private async Publish(id: string, text: string): Promise<void>
    {
        const outcome = compilePackage([], [{ uri: `${id}.todl`, text }], { id, version: RuntimeTierFixture.Version })
        assert.ok(outcome.ok, JSON.stringify(outcome.errors))
        await new BlobPackageStore(new StoragePackageSink(new NodeFsStorage(this.packages))).persist(outcome.package!)
    }

    /** Governs only crm.Account: the reader holds an organisation-level read (and create) on it; notes.Note is never named. */
    private static Model(): ISecurityModelConfig
    {
        return {
            businessUnits: [{ id: PpSecurityHarness.RootBu, name: RuntimeTierFixture.RootName }, { id: PpSecurityHarness.SalesBu, name: RuntimeTierFixture.SalesName, parent: PpSecurityHarness.RootBu }],
            teams: [],
            membership: { claimsMapping: [], overrides: [{ principalId: RuntimeTierFixture.Reader, homeBusinessUnit: PpSecurityHarness.SalesBu, teams: [] }] },
            ownershipRules: [{ concept: RuntimeTierFixture.Account, owningBusinessUnit: { kind: OwnershipSourceKind.FromField, value: PpSecurityHarness.OwningBuField } }],
            roles: [{ id: RuntimeTierFixture.ReaderRole, name: RuntimeTierFixture.ReaderRoleName, privileges: [
                { action: PrivilegeAction.Read, concept: RuntimeTierFixture.Account, level: AccessLevel.Organization },
                { action: PrivilegeAction.Create, concept: RuntimeTierFixture.Account, level: AccessLevel.Organization },
            ] }],
            roleAssignment: { claimsMapping: [], overrides: [{ principalId: RuntimeTierFixture.Reader, roles: [RuntimeTierFixture.ReaderRole] }], teamRoles: [] },
        }
    }

    private async Dispose(): Promise<void>
    {
        await this.server?.Dispose()
        rmSync(this.packages, { recursive: true, force: true })
        rmSync(this.apps, { recursive: true, force: true })
        rmSync(this.identityRoot, { recursive: true, force: true })
        PpSecurityHarness.ClearKey()
    }
}

/** A development solution with two Orders: o1 owned by the sales unit, o2 by root (TODL no longer has `policy` declarations, A1). */
class DevTierFixture
{
    public static readonly MemberId = 'models'
    public static readonly HiddenId = 'acme.o2'
    public static readonly VisibleId = 'acme.o1'
    private static readonly PackagesPrefix = 'tier2-dev-pkgs-'
    private static readonly SolutionPrefix = 'tier2-dev-sol-'
    private static readonly IdentityPrefix = 'tier2-dev-id-'
    private static readonly Order = 'acme.Order'
    private static readonly ShopTodl = 'namespace acme { concept Order { owningBu : string?; } model Shop : acme { Order o1 { label = "a"; owningBu = "sales"; } Order o2 { label = "b"; owningBu = "root"; } } }'
    private static readonly NoConnectors = 'no connectors'
    private static readonly SolutionModelFile = join('models', 'model.todl')

    private readonly sessions: DevSession[] = []

    public static async Run(body: (fx: DevTierFixture) => Promise<void>): Promise<void>
    {
        const fx = new DevTierFixture()
        try
        {
            await body(fx)
        }
        finally
        {
            await fx.Dispose()
        }
    }


    /** The harness BU-depth model on acme.Order: the reader (home unit sales) reads sales-owned Orders only, so o2 (root) is hidden. */
    private static SalesOnly(): ISecurityModelConfig
    {
        const model = PpSecurityHarness.BuSecurityModel(RuntimeTierFixture.Reader)
        return {
            ...model,
            ownershipRules: model.ownershipRules.map(rule => ({ ...rule, concept: DevTierFixture.Order })),
            roles: model.roles.map(role => ({ ...role, privileges: role.privileges.map(privilege => ({ ...privilege, concept: DevTierFixture.Order })) })),
        }
    }

    /** A runtime connection over a server with identity, the solution open and the sales-only security model seeded. */
    public async RuntimeClientWithIdentity(): Promise<PragmaticClient>
    {
        const packages = mkdtempSync(join(tmpdir(), DevTierFixture.PackagesPrefix))
        const solution = mkdtempSync(join(tmpdir(), DevTierFixture.SolutionPrefix))
        const identityRoot = mkdtempSync(join(tmpdir(), DevTierFixture.IdentityPrefix))
        cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), solution, { recursive: true })
        writeFileSync(join(solution, DevTierFixture.SolutionModelFile), DevTierFixture.ShopTodl)
        PpSecurityHarness.SetKey()
        const server = new PragmaticServer({ packagesRoot: packages, identity: PpSecurityHarness.Identity(identityRoot) })
        await server.Start()
        await server.OpenSolution(solution)
        await PpSecurityHarness.Seed(server, DevTierFixture.SalesOnly())
        const language = await server.LanguageService() as SolutionLanguageService
        const manager = await server.Manager()
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(serverSocket, language, manager, PpSecurityHarness.Context(RuntimeTierFixture.Reader), () => Promise.reject(new Error(DevTierFixture.NoConnectors)), undefined,
            undefined, undefined, undefined, undefined, undefined, undefined, TenantPurpose.Runtime, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            await server.FieldReadMaskSource(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, await server.DepthFilterSource())
        const session = new DevSession(new WireConnection(PragmaticClient.CreateOverSocket(clientSocket), handler), server, language, manager, [solution, packages, identityRoot])
        this.sessions.push(session)
        return session.Connection.Client
    }

    private async Dispose(): Promise<void>
    {
        for (const session of this.sessions.reverse())
        {
            await session.dispose()
        }
        PpSecurityHarness.ClearKey()
    }
}

test('own concept the security model does not govern is denied', async () =>
{
    await RuntimeTierFixture.Run(async fx =>
    {
        const created = await fx.CreateNote(RuntimeTierFixture.Reader)
        assert.equal(created.results[0]?.status, AppWriteStatus.Denied)
    })
})

test('runtime model view hides an instance the access depth hides', async () =>
{
    await DevTierFixture.Run(async fx =>
    {
        const client = await fx.RuntimeClientWithIdentity()
        const page = await client.ModelView(DevTierFixture.MemberId)
        const ids = page.items.map(member => member.id)
        assert.ok(ids.includes(DevTierFixture.VisibleId), JSON.stringify(ids))
        assert.ok(!ids.includes(DevTierFixture.HiddenId), JSON.stringify(ids))
    })
})
