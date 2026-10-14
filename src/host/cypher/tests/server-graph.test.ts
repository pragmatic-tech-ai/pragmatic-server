import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cypher } from '@pragmatic-tech-ai/todl'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../../pragmatic-server.js'

class ServerGraphFixture
{
    private static readonly SolutionPrefix = 'sg-sol-'
    private static readonly PackagesPrefix = 'sg-pkgs-'
    private static readonly ModelFile = join('models', 'model.todl')
    private static readonly ModelTodl = 'namespace acme { concept Widget { label : string?; } model Shop : acme { Widget w1 {} Widget w2 {} } }'
    private static readonly ExpectedCount = 2
    private static readonly CountQuery = 'MATCH (x) RETURN count(x) AS c'

    public static Permissive(): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('p1', 't1', PrincipalKind.User, new Map(), [])
        const grants = [new Grant('p1', Role.Owner, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    public static async Run(): Promise<void>
    {
        const solution = mkdtempSync(join(tmpdir(), ServerGraphFixture.SolutionPrefix))
        const packages = mkdtempSync(join(tmpdir(), ServerGraphFixture.PackagesPrefix))
        cpSync(join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'sample-solution'), solution, { recursive: true })
        writeFileSync(join(solution, ServerGraphFixture.ModelFile), ServerGraphFixture.ModelTodl)
        const server = new PragmaticServer({ packagesRoot: packages })
        try
        {
            await server.Start()
            await server.OpenSolution(solution)
            const graph = await server.Graph(ServerGraphFixture.Permissive())
            const result = Cypher.CypherEngine.OverQuery(graph).Execute(ServerGraphFixture.CountQuery)
            const count = (result.Rows[0]![0] as { Value: number }).Value
            assert.equal(count, ServerGraphFixture.ExpectedCount)
        }
        finally
        {
            await server.Dispose()
            rmSync(solution, { recursive: true, force: true })
            rmSync(packages, { recursive: true, force: true })
        }
    }
}

test('server.Graph composes the open solution into a queryable graph', async () =>
{
    await ServerGraphFixture.Run()
})
