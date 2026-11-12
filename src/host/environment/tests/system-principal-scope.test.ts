import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessScope } from '@pragmatic-tech-ai/graph'
import type { CellValue } from '@pragmatic-tech-ai/graph'
import { SystemNames } from '@pragmatic-tech-ai/todl/engine'
import { AccessLevel, BaseRole, PrivilegeAction, SystemPrincipal } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../../pragmatic-server.js'
import { TenantPurpose } from '../../../tenancy/tenant-purpose.js'
import { EnvironmentFixture } from './environment-fixture.js'
import { Tier1Fx } from './tier1-fixture.js'

class SystemFx
{
    public static readonly E1 = 'E1'
    public static readonly E2 = 'E2'
    public static readonly N1 = 'N1'
    public static readonly Created = 'created'
    public static readonly HighSalary = 150000
    public static readonly Salaries = 'MATCH (e:`hr.Employee`) RETURN e.Salary AS s ORDER BY s'
    public static readonly RuntimeOnly = /applications are a runtime-tenant feature/
    private static readonly SelectPrefix = 'MATCH (n:`'
    private static readonly SelectSuffix = '`) RETURN n.name AS name ORDER BY name'

    /** E1 alice/sales, E2 bob/marketing (both with a secured Salary) and N1 (a concept no role covers). */
    public static async Seed(fx: EnvironmentFixture): Promise<void>
    {
        await fx.Seed([
            Tier1Fx.Owned(Tier1Fx.Employee, SystemFx.E1, Tier1Fx.Alice, Tier1Fx.Sales, { [Tier1Fx.Salary]: SystemFx.HighSalary }),
            Tier1Fx.Owned(Tier1Fx.Employee, SystemFx.E2, Tier1Fx.Bob, Tier1Fx.Marketing, { [Tier1Fx.Salary]: SystemFx.HighSalary }),
            Tier1Fx.Owned(Tier1Fx.Note, SystemFx.N1, Tier1Fx.Alice, Tier1Fx.Sales),
        ])
    }

    public static async Names(server: PragmaticServer, scope: AccessScope, concept: string): Promise<unknown[]>
    {
        return Tier1Fx.Column(server, scope, SystemFx.SelectPrefix + concept + SystemFx.SelectSuffix)
    }
}

describe('system principal scope', () =>
{
    test('system scope sees every record and secured field', async () =>
    {
        await Tier1Fx.Run({ Identity: true, SecurityModel: Tier1Fx.Setting() }, async (fx, server) =>
        {
            await SystemFx.Seed(fx)
            const scope = (await server.SystemScope()).Scope
            assert.deepEqual(await SystemFx.Names(server, scope, Tier1Fx.Employee), [SystemFx.E1, SystemFx.E2], 'every business unit')
            assert.deepEqual(await Tier1Fx.Column(server, scope, SystemFx.Salaries), [SystemFx.HighSalary, SystemFx.HighSalary], 'the secured field is not hidden')
            assert.deepEqual(await SystemFx.Names(server, scope, Tier1Fx.Note), [SystemFx.N1], 'a concept no role covers')
        })
    })

    test('records created under the system scope are owned by the system principal in the root unit', async () =>
    {
        await Tier1Fx.Run({ Identity: true, SecurityModel: Tier1Fx.Setting() }, async (_fx, server) =>
        {
            const scope = await server.SystemScope()
            const place = scope.Placement().Place(Tier1Fx.Employee, new Map<string, CellValue>([[Tier1Fx.Name, SystemFx.Created]]))
            const engine = await Tier1Fx.Engine(server)
            const transaction = await engine.Begin(scope.Scope, { Connector: scope.Connector })
            transaction.CreateNode(place.PublicId, Tier1Fx.Employee, { Owner: place.Owner })
            transaction.SetProperty(place.PublicId, Tier1Fx.Name, SystemFx.Created)
            for (const [member, value] of place.Defaults ?? []) transaction.SetDefault(place.PublicId, member, value)
            await transaction.Commit()
            const reader = await engine.BeginRead(AccessScope.System, { Connector: scope.Connector })
            try
            {
                const node = await reader.ReadNode(place.PublicId)
                assert.equal(node?.Properties.get(SystemNames.Owner), SystemPrincipal.IdFor(EnvironmentFixture.TenantId))
                assert.equal(node?.Properties.get(SystemNames.OwningBusinessUnit), Tier1Fx.Contoso, 'the root business unit (C7)')
            }
            finally
            {
                reader.dispose()
            }
        })
    })

    test('system scope follows a security reload', async () =>
    {
        await Tier1Fx.Run({ Identity: true, SecurityModel: Tier1Fx.Setting() }, async (fx, server) =>
        {
            await SystemFx.Seed(fx)
            const before = await server.SystemScope()
            assert.equal(await server.SystemScope(), before, 'memoized within one generation')
            await fx.SaveSecurityModel(Tier1Fx.Setting({ RoleOverrides: [Tier1Fx.Override(BaseRole.Reader, Tier1Fx.Employee, PrivilegeAction.Read, AccessLevel.User)] }))
            const after = await server.SystemScope()
            assert.notEqual(after, before, 'a fresh scope after the reload')
            assert.notEqual(after.Digest, before.Digest)
            assert.deepEqual(await SystemFx.Names(server, after.Scope, Tier1Fx.Employee), [SystemFx.E1, SystemFx.E2], 'with the same rights')
        })
    })

    test('development tenant has no system scope', async () =>
    {
        const server = new PragmaticServer({ purpose: TenantPurpose.Development })
        try
        {
            await assert.rejects(server.SystemScope(), SystemFx.RuntimeOnly)
        }
        finally
        {
            await server.Dispose()
        }
    })

    test('background work carries the system context', async () =>
    {
        await Tier1Fx.Run({ Identity: true, SecurityModel: Tier1Fx.Setting() }, async (_fx, server) =>
        {
            const scope = await server.SystemScope()
            assert.equal(scope.Connector.Key, SystemPrincipal.IdFor(EnvironmentFixture.TenantId))
        })
    })
})
