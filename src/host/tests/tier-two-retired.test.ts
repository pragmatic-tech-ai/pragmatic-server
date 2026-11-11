import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryMessageSocket, PragmaticClient, AppWriteOpKind, AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { compilePackage, BlobPackageStore, StoragePackageSink } from '@pragmatic-tech-ai/todl'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { AccessLevel, PrivilegeAction, OwnershipSourceKind } from '@pragmatic-tech-ai/todl-identity'
import type { AccessContext, ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../pragmatic-server.js'
import { TenantPurpose } from '../../tenancy/tenant-purpose.js'
import { BuiltinStoreEngine } from '../connectors/builtin-store-engine.js'
import { ServerConnectionHandler } from '../server-connection-handler.js'
import { PpSecurityHarness } from '../cypher/tests/pp-security-harness.js'

/*
 * Tier 2 (per-app access policy files, TODL model policies, app-private concept governance) is retired: only the
 * tenant security model (tier 1) decides runtime and dev visibility.
 */

/** A runtime tenant with identity: app `crm` binds packages crm (crm.Account, governed) and notes (notes.Note, NOT governed). */
class RuntimeTierFixture
{
    public static readonly Reader = 'p1'
    public static readonly AccountLabels = 'MATCH (a:Account) RETURN a.label AS label'
    public static readonly NoteLabels = 'MATCH (n:Note) RETURN n.label AS label'
    public static readonly AccountLabel = 'acme'
    public static readonly Note = 'notes.Note'
    private static readonly AppName = 'crm'
    private static readonly Version = '1.0.0'
    private static readonly Account = 'crm.Account'
    private static readonly CrmPkg = 'crm'
    private static readonly NotesPkg = 'notes'
    private static readonly ManifestFile = 'application.json'
    // the retired per-app policy setting file, written to prove the server no longer reads it
    private static readonly RetiredPolicyFile = 'access-policy.json'
    private static readonly Deny = 'deny'
    private static readonly Read = 'read'
    private static readonly ReaderRole = 'reader'
    private static readonly ReaderRoleName = 'Reader'
    private static readonly RootName = 'Root'
    private static readonly SalesName = 'Sales'
    private static readonly NoteLabel = 'draft'
    private static readonly PackagesPrefix = 'tier2-pkgs-'
    private static readonly AppsPrefix = 'tier2-apps-'
    private static readonly IdentityPrefix = 'tier2-id-'
    private static readonly NoConnectors = 'no connectors'
    private static readonly CrmTodl = 'namespace crm { concept Account { owningBu : string; } model Crm : crm { annotate entrypoint { } Account a1 { label = "acme"; owningBu = "sales"; } } }'
    private static readonly NotesTodl = 'namespace notes { concept Note { } model Notes : notes { annotate entrypoint { } Note n1 { label = "hello"; } } }'

    private readonly packages = mkdtempSync(join(tmpdir(), RuntimeTierFixture.PackagesPrefix))
    private readonly apps = mkdtempSync(join(tmpdir(), RuntimeTierFixture.AppsPrefix))
    private readonly identityRoot = mkdtempSync(join(tmpdir(), RuntimeTierFixture.IdentityPrefix))
    private readonly disposables: Array<() => Promise<void>> = []
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

    /**
     * Writes the retired per-app policy setting denying every read of crm.Account: `deny read when entity.owningBu ==
     * "sales"`, which every seeded Account matches (the serialized policy AST: Compare = 2, Eq = 0, Ref = 0, Entity = 1, Literal = 1).
     */
    public DenyEveryAccount(): void
    {
        const predicate = { kind: 2, op: 0, left: { kind: 0, root: 1, member: PpSecurityHarness.OwningBuField }, right: { kind: 1, value: PpSecurityHarness.SalesBu } }
        const rules = [{ effect: RuntimeTierFixture.Deny, action: RuntimeTierFixture.Read, predicate }]
        writeFileSync(join(this.apps, RuntimeTierFixture.AppName, RuntimeTierFixture.RetiredPolicyFile), JSON.stringify({ [RuntimeTierFixture.Account]: rules }))
    }

    /** A wire client bound to the app as `principal`. */
    public async Client(principal: string): Promise<PragmaticClient>
    {
        const server = this.server!
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const handler = ServerConnectionHandler.Attach(
            serverSocket, await server.LanguageService(), await server.Manager(), PpSecurityHarness.Context(principal),
            () => Promise.reject(new Error(RuntimeTierFixture.NoConnectors)), server.DevCypher(),
            undefined, undefined, undefined, undefined, undefined, undefined, TenantPurpose.Runtime,
            server.Applications(), (ctx, name, labels) => server.GraphForPragmaticApp(ctx, name, labels),
            undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            server)
        const client = PragmaticClient.CreateOverSocket(clientSocket)
        this.disposables.push(async () =>
        {
            await client.DisposeAsync()
            handler.Dispose()
        })
        await client.OpenApplication(RuntimeTierFixture.AppName)
        return client
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
        for (const d of this.disposables.reverse())
        {
            await d()
        }
        await this.server?.Dispose()
        rmSync(this.packages, { recursive: true, force: true })
        rmSync(this.apps, { recursive: true, force: true })
        rmSync(this.identityRoot, { recursive: true, force: true })
        PpSecurityHarness.ClearKey()
    }
}

/** A development solution whose saved model declares (or not) a read policy on Order admitting only label "a". */
class DevTierFixture
{
    public static readonly MemberId = 'models'
    public static readonly OrderLabels = 'MATCH (o:Order) RETURN o.label AS label'
    public static readonly HiddenId = 'acme.o2'
    /** Both seeded Order labels: the policy would admit only the first. */
    public static readonly AllLabels = ['a', 'b']
    private static readonly PackagesPrefix = 'tier2-dev-pkgs-'
    private static readonly SolutionPrefix = 'tier2-dev-sol-'
    private static readonly NoConnectors = 'no connectors'
    private static readonly SolutionModelFile = join('models', 'model.todl')
    private static readonly Policy = 'policy Order { allow read when entity.label == "a"; } '

    private readonly disposables: Array<() => Promise<void>> = []

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

    private static Todl(withPolicy: boolean): string
    {
        const policy = withPolicy ? DevTierFixture.Policy : ''
        return `namespace acme { concept Order { } ${policy}model Shop : acme { Order o1 { label = "a"; } Order o2 { label = "b"; } } }`
    }

    /** A client over a server with the solution open, attached with the development arguments or as a runtime connection. */
    public async Client(withPolicy: boolean, purpose: TenantPurpose = TenantPurpose.Development): Promise<PragmaticClient>
    {
        const packages = mkdtempSync(join(tmpdir(), DevTierFixture.PackagesPrefix))
        const solution = mkdtempSync(join(tmpdir(), DevTierFixture.SolutionPrefix))
        cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), solution, { recursive: true })
        writeFileSync(join(solution, DevTierFixture.SolutionModelFile), DevTierFixture.Todl(withPolicy))
        const server = new PragmaticServer({ packagesRoot: packages })
        await server.Start()
        await server.OpenSolution(solution)
        const language = await server.LanguageService()
        const manager = await server.Manager()
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const development = ServerConnectionHandler.DevelopmentAttachArgs(server)
        const handler = purpose === TenantPurpose.Development
            ? ServerConnectionHandler.Attach(serverSocket, language, manager, PpSecurityHarness.Context(RuntimeTierFixture.Reader), () => Promise.reject(new Error(DevTierFixture.NoConnectors)), development.devCypher,
                undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
                undefined, undefined, undefined, undefined, development.devGraphService, undefined, development.devModelView)
            : ServerConnectionHandler.Attach(serverSocket, language, manager, PpSecurityHarness.Context(RuntimeTierFixture.Reader), () => Promise.reject(new Error(DevTierFixture.NoConnectors)), undefined,
                undefined, undefined, undefined, undefined, undefined, undefined, purpose)
        const client = PragmaticClient.CreateOverSocket(clientSocket)
        this.disposables.push(async () =>
        {
            await client.DisposeAsync()
            handler.Dispose()
            await (language as SolutionLanguageService).WhenIdle()
            await manager.CloseSolution()
            await server.Dispose()
            rmSync(solution, { recursive: true, force: true })
            rmSync(packages, { recursive: true, force: true })
        })
        return client
    }

    private async Dispose(): Promise<void>
    {
        for (const d of this.disposables.reverse())
        {
            await d()
        }
    }
}

class TierColumn
{
    public static Of(result: { items: unknown[][] }): unknown[]
    {
        return result.items.map(r => r[0]).sort()
    }
}

test('access-policy file is ignored', async () =>
{
    await RuntimeTierFixture.Run(async fx =>
    {
        fx.DenyEveryAccount()
        const client = await fx.Client(RuntimeTierFixture.Reader)
        const rows = await client.CypherQuery(RuntimeTierFixture.AccountLabels)
        assert.deepEqual(TierColumn.Of(rows), [RuntimeTierFixture.AccountLabel])
    })
})

test('own concept the security model does not govern is denied', async () =>
{
    await RuntimeTierFixture.Run(async fx =>
    {
        const client = await fx.Client(RuntimeTierFixture.Reader)
        const rows = await client.CypherQuery(RuntimeTierFixture.NoteLabels)
        assert.deepEqual(TierColumn.Of(rows), [])
        const created = await fx.CreateNote(RuntimeTierFixture.Reader)
        assert.equal(created.results[0]?.status, AppWriteStatus.Denied)
    })
})

test('dev model policy is ignored', async () =>
{
    await DevTierFixture.Run(async fx =>
    {
        const governed = await (await fx.Client(true)).CypherQuery(DevTierFixture.OrderLabels)
        const plain = await (await fx.Client(false)).CypherQuery(DevTierFixture.OrderLabels)
        assert.deepEqual(TierColumn.Of(plain), DevTierFixture.AllLabels)
        assert.deepEqual(TierColumn.Of(governed), TierColumn.Of(plain))
    })
})

test('runtime model view ignores model policies', async () =>
{
    await DevTierFixture.Run(async fx =>
    {
        const client = await fx.Client(true, TenantPurpose.Runtime)
        const page = await client.ModelView(DevTierFixture.MemberId)
        assert.ok(page.items.some(member => member.id === DevTierFixture.HiddenId), JSON.stringify(page.items.map(member => member.id)))
    })
})
