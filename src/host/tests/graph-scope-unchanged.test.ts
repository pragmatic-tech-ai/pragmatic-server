import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toJSON, ModelShardExtractor } from '@pragmatic-tech-ai/todl'
import type { SolutionLanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { AccessLevel, PrivilegeAction, OwnershipSourceKind } from '@pragmatic-tech-ai/todl-identity'
import type { AccessContext, ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../pragmatic-server.js'
import { CypherLimits } from '../../config/cypher-limits.js'
import { PagingLimits } from '../../config/paging-limits.js'
import { CypherParamConverter } from '../cypher/cypher-param-converter.js'
import { PpSecurityHarness } from '../cypher/tests/pp-security-harness.js'

/**
 * The dev-authoring graph (the dev engine, tenant-wide and model-scoped) must NOT inherit the bound-app bypass: a concept the tenant model does not
 * reference stays fail-closed there, even though it would be "ungoverned". Widget is governed (p2 holds the grant); Gadget is not.
 */
class ScopeFixture
{
    public static readonly Plain = 'p1'
    public static readonly Granted = 'p2'
    public static readonly WidgetQuery = 'MATCH (w:Widget) RETURN w.label AS v'
    public static readonly GadgetQuery = 'MATCH (g:Gadget) RETURN g.label AS v'
    private static readonly SolutionPrefix = 'gsu-sol-'
    private static readonly PackagesPrefix = 'gsu-pkgs-'
    private static readonly IdentityPrefix = 'gsu-id-'
    private static readonly ModelFile = join('models', 'model.todl')
    private static readonly Widget = 'acme.Widget'
    private static readonly ReaderRole = 'reader'

    public static ModelTodl(): string
    {
        const bu = PpSecurityHarness.OwningBuField
        const sales = PpSecurityHarness.SalesBu
        return `namespace acme { concept Widget { ${bu} : string?; } concept Gadget { ${bu} : string?; } `
            + `model Shop : acme { Widget w1 { ${bu} = "${sales}"; label = "W1"; } Gadget g1 { ${bu} = "${sales}"; label = "G1"; } } }`
    }

    /** Governs ONLY acme.Widget (privilege + ownership); p2 holds the org-level read role, p1 holds none. */
    public static Model(): ISecurityModelConfig
    {
        return {
            businessUnits: [{ id: PpSecurityHarness.RootBu, name: 'Root' }, { id: PpSecurityHarness.SalesBu, name: 'Sales', parent: PpSecurityHarness.RootBu }],
            teams: [],
            membership: { claimsMapping: [], overrides: [
                { principalId: ScopeFixture.Plain, homeBusinessUnit: PpSecurityHarness.SalesBu, teams: [] },
                { principalId: ScopeFixture.Granted, homeBusinessUnit: PpSecurityHarness.SalesBu, teams: [] },
            ] },
            ownershipRules: [{ concept: ScopeFixture.Widget, owningBusinessUnit: { kind: OwnershipSourceKind.FromField, value: PpSecurityHarness.OwningBuField } }],
            roles: [{ id: ScopeFixture.ReaderRole, name: 'Reader', privileges: [{ action: PrivilegeAction.Read, concept: ScopeFixture.Widget, level: AccessLevel.Organization }] }],
            roleAssignment: { claimsMapping: [], teamRoles: [], overrides: [{ principalId: ScopeFixture.Granted, roles: [ScopeFixture.ReaderRole] }] },
        }
    }

    /** The first column of `query` on the dev engine for `context` (model-scoped when `modelId` is given), sorted. */
    public static async Column(server: PragmaticServer, context: AccessContext, query: string, modelId?: string): Promise<string[]>
    {
        const limits = new CypherLimits()
        const page = await server.DevCypher().Run(context, {
            Source: query,
            Parameters: new Map(),
            CanonicalParameters: CypherParamConverter.Canonical(undefined),
            ...(modelId === undefined ? {} : { ModelId: modelId }),
            Page: { Params: {}, Limits: new PagingLimits(), RowCap: limits.RowCap },
            TimeoutMs: limits.TimeoutMs,
            MaxVarLength: limits.MaxVarLength,
        })
        return page.items.map(r => (typeof r[0] === 'string' ? r[0] : '')).sort()
    }

    public static async With(body: (server: PragmaticServer, modelId: string) => Promise<void>): Promise<void>
    {
        const solution = mkdtempSync(join(tmpdir(), ScopeFixture.SolutionPrefix))
        const packages = mkdtempSync(join(tmpdir(), ScopeFixture.PackagesPrefix))
        const identityRoot = mkdtempSync(join(tmpdir(), ScopeFixture.IdentityPrefix))
        cpSync(join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'sample-solution'), solution, { recursive: true })
        writeFileSync(join(solution, ScopeFixture.ModelFile), ScopeFixture.ModelTodl())
        PpSecurityHarness.SetKey()
        const server = new PragmaticServer({ packagesRoot: packages, identity: PpSecurityHarness.Identity(identityRoot) })
        try
        {
            await server.Start()
            await server.OpenSolution(solution)
            await PpSecurityHarness.Seed(server, ScopeFixture.Model())
            const language = await server.LanguageService() as SolutionLanguageService
            await language.WhenIdle()
            const manager = await server.Manager()
            const member = [...manager.ActiveSolution!.Members].find(m => m.Storage !== undefined)!
            const view = await language.ModelView(member.Storage!)
            const modelId = ModelShardExtractor.ModelsOf(toJSON(view!.model)).map(m => String(m))[0]
            await body(server, modelId)
            await language.WhenIdle()
            await manager.CloseSolution()
        }
        finally
        {
            await server.Dispose()
            PpSecurityHarness.ClearKey()
            rmSync(solution, { recursive: true, force: true })
            rmSync(packages, { recursive: true, force: true })
            rmSync(identityRoot, { recursive: true, force: true })
        }
    }
}

test('the model-scoped dev graph keeps the fail-closed depth filter: a concept the model does not reference stays denied', async () =>
{
    await ScopeFixture.With(async (server, modelId) =>
    {
        const granted = PpSecurityHarness.Context(ScopeFixture.Granted)
        assert.deepEqual(await ScopeFixture.Column(server, granted, ScopeFixture.WidgetQuery, modelId), ['W1'], 'the governed grant still reads')
        assert.deepEqual(await ScopeFixture.Column(server, granted, ScopeFixture.GadgetQuery, modelId), [], 'the ungoverned concept gets no bypass')
        const plain = PpSecurityHarness.Context(ScopeFixture.Plain)
        assert.deepEqual(await ScopeFixture.Column(server, plain, ScopeFixture.WidgetQuery, modelId), [])
        assert.deepEqual(await ScopeFixture.Column(server, plain, ScopeFixture.GadgetQuery, modelId), [])
    })
})

test('the tenant-wide dev graph keeps the fail-closed depth filter: a concept the model does not reference stays denied', async () =>
{
    await ScopeFixture.With(async server =>
    {
        const granted = PpSecurityHarness.Context(ScopeFixture.Granted)
        assert.deepEqual(await ScopeFixture.Column(server, granted, ScopeFixture.WidgetQuery), ['W1'])
        assert.deepEqual(await ScopeFixture.Column(server, granted, ScopeFixture.GadgetQuery), [])
    })
})
