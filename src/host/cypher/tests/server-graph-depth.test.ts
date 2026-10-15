import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cypher } from '@pragmatic-tech-ai/todl'
import type { AccessContext, ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../../pragmatic-server.js'
import { PpSecurityHarness } from './pp-security-harness.js'

type GraphParam = Parameters<typeof Cypher.CypherEngine.OverQuery>[0]

class ServerGraphDepthFixture
{
    private static readonly SolutionPrefix = 'sgd-sol-'
    private static readonly PackagesPrefix = 'sgd-pkgs-'
    private static readonly IdentityPrefix = 'sgd-id-'
    private static readonly ModelFile = join('models', 'model.todl')
    private static readonly Namespace = 'acme'
    private static readonly PrincipalId = 'p1'
    private static readonly SalesLabelA = 'alpha'
    private static readonly RootLabel = 'beta'
    private static readonly SalesLabelB = 'gamma'
    private static readonly LabelQuery = 'MATCH (w:Widget) RETURN w.label AS l'
    private static readonly CountAllQuery = 'MATCH (x) RETURN count(x) AS c'

    public static Model(withPolicy: boolean): string
    {
        const concept = PpSecurityHarness.Concept
        const field = PpSecurityHarness.OwningBuField
        const policy = withPolicy ? `policy ${concept} { allow read when entity.${field} == "${PpSecurityHarness.SalesBu}"; allow read when entity.${field} == "${PpSecurityHarness.RootBu}"; deny read when entity.label == "${ServerGraphDepthFixture.SalesLabelB}"; } ` : ''
        const instances = `${concept} w1 { ${field} = "${PpSecurityHarness.SalesBu}"; label = "${ServerGraphDepthFixture.SalesLabelA}"; } `
            + `${concept} w2 { ${field} = "${PpSecurityHarness.RootBu}"; label = "${ServerGraphDepthFixture.RootLabel}"; } `
            + `${concept} w3 { ${field} = "${PpSecurityHarness.SalesBu}"; label = "${ServerGraphDepthFixture.SalesLabelB}"; }`
        return `namespace ${ServerGraphDepthFixture.Namespace} { concept ${concept} { ${field} : string?; label : string?; } ${policy}model Shop : ${ServerGraphDepthFixture.Namespace} { ${instances} } }`
    }

    public static Labels(graph: GraphParam): string[]
    {
        const result = Cypher.CypherEngine.OverQuery(graph).Execute(ServerGraphDepthFixture.LabelQuery)
        return result.Rows.map(r => String((r[0] as unknown as { Value: string }).Value)).sort()
    }

    public static Count(graph: GraphParam): number
    {
        const result = Cypher.CypherEngine.OverQuery(graph).Execute(ServerGraphDepthFixture.CountAllQuery)
        return (result.Rows[0]![0] as unknown as { Value: number }).Value
    }

    /** Opens a solution holding `modelTodl`, optionally with identity + a seeded security model, and runs `body`. */
    public static async With(modelTodl: string, model: ISecurityModelConfig | undefined, body: (server: PragmaticServer) => Promise<void>): Promise<void>
    {
        const solution = mkdtempSync(join(tmpdir(), ServerGraphDepthFixture.SolutionPrefix))
        const packages = mkdtempSync(join(tmpdir(), ServerGraphDepthFixture.PackagesPrefix))
        const identityRoot = mkdtempSync(join(tmpdir(), ServerGraphDepthFixture.IdentityPrefix))
        cpSync(join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'sample-solution'), solution, { recursive: true })
        writeFileSync(join(solution, ServerGraphDepthFixture.ModelFile), modelTodl)
        PpSecurityHarness.SetKey()
        const server = model === undefined
            ? new PragmaticServer({ packagesRoot: packages })
            : new PragmaticServer({ packagesRoot: packages, identity: PpSecurityHarness.Identity(identityRoot) })
        try
        {
            await server.Start()
            await server.OpenSolution(solution)
            if (model !== undefined)
            {
                await PpSecurityHarness.Seed(server, model)
            }
            await body(server)
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

    public static Context(): AccessContext
    {
        return PpSecurityHarness.Context(ServerGraphDepthFixture.PrincipalId)
    }

    public static Bu(): ISecurityModelConfig
    {
        return ServerGraphDepthFixture.Qualify(PpSecurityHarness.BuSecurityModel(ServerGraphDepthFixture.PrincipalId))
    }

    public static Org(): ISecurityModelConfig
    {
        return ServerGraphDepthFixture.Qualify(PpSecurityHarness.OrgSecurityModel(ServerGraphDepthFixture.PrincipalId))
    }

    /** Dev-graph node types are namespace-qualified (acme.Widget); the harness model names the bare concept. */
    private static Qualify(model: ISecurityModelConfig): ISecurityModelConfig
    {
        const qualified = `${ServerGraphDepthFixture.Namespace}.${PpSecurityHarness.Concept}`
        return {
            ...model,
            ownershipRules: model.ownershipRules.map(r => ({ ...r, concept: qualified })),
            roles: (model.roles ?? []).map(r => ({ ...r, privileges: r.privileges.map(p => ({ ...p, concept: qualified })) })),
        }
    }

    public static get All(): string[]
    {
        return [ServerGraphDepthFixture.SalesLabelA, ServerGraphDepthFixture.SalesLabelB, ServerGraphDepthFixture.RootLabel].sort()
    }

    public static get SalesOnly(): string[]
    {
        return [ServerGraphDepthFixture.SalesLabelA, ServerGraphDepthFixture.SalesLabelB].sort()
    }

    public static get Alpha(): string[]
    {
        return [ServerGraphDepthFixture.SalesLabelA]
    }

    public static get Beta(): string[]
    {
        return [ServerGraphDepthFixture.SalesLabelA, ServerGraphDepthFixture.RootLabel].sort()
    }
}

test('state 1: BusinessUnit depth keeps only sales-owned widgets on the dev graph', async () =>
{
    await ServerGraphDepthFixture.With(ServerGraphDepthFixture.Model(false), ServerGraphDepthFixture.Bu(), async server =>
    {
        const graph = await server.Graph(ServerGraphDepthFixture.Context())
        assert.deepEqual(ServerGraphDepthFixture.Labels(graph), ServerGraphDepthFixture.SalesOnly)
    })
})

test('depth leaves no extra nodes: the all-node count equals the surviving widgets (structural nodes are not graph-visible)', async () =>
{
    await ServerGraphDepthFixture.With(ServerGraphDepthFixture.Model(false), ServerGraphDepthFixture.Bu(), async server =>
    {
        const graph = await server.Graph(ServerGraphDepthFixture.Context())
        assert.equal(ServerGraphDepthFixture.Count(graph), ServerGraphDepthFixture.SalesOnly.length)
    })
})

test('compose: predicate deny wins over depth allow-all (Organization level)', async () =>
{
    await ServerGraphDepthFixture.With(ServerGraphDepthFixture.Model(true), ServerGraphDepthFixture.Org(), async server =>
    {
        const graph = await server.Graph(ServerGraphDepthFixture.Context())
        assert.deepEqual(ServerGraphDepthFixture.Labels(graph), ServerGraphDepthFixture.Beta)
    })
})

test('compose: depth deny wins over predicate allow, and the predicate still denies (BusinessUnit level)', async () =>
{
    await ServerGraphDepthFixture.With(ServerGraphDepthFixture.Model(true), ServerGraphDepthFixture.Bu(), async server =>
    {
        const graph = await server.Graph(ServerGraphDepthFixture.Context())
        assert.deepEqual(ServerGraphDepthFixture.Labels(graph), ServerGraphDepthFixture.Alpha)
    })
})

test('state 3: an identity-less dev server returns every widget (depth inactive)', async () =>
{
    await ServerGraphDepthFixture.With(ServerGraphDepthFixture.Model(false), undefined, async server =>
    {
        const graph = await server.Graph(ServerGraphDepthFixture.Context())
        assert.deepEqual(ServerGraphDepthFixture.Labels(graph), ServerGraphDepthFixture.All)
    })
})
