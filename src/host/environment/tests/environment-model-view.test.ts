import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessScope } from '@pragmatic-tech-ai/graph'
import { EdgeKind, Tier } from '@pragmatic-tech-ai/todl'
import { DeliveryChannel } from '@pragmatic-tech-ai/todl/engine'
import { CursorStaleError, ErrorCodes } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ModelMemberDto, ModelViewPageDto, PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessLevel, OwnershipSourceKind, Principal, PrincipalKind, PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { EnvironmentFixture } from './environment-fixture.js'
import type { IEnvironmentFixtureOptions } from './environment-fixture.js'

/**
 * A runtime tenant delivering `crm` (crm.Account, engine-stored, with an owner field, a secured `secret` and a secured
 * `boss` relationship) through `crm-app`. With identity, p1 and p2 hold User-level read on crm.Account (own rows only)
 * and only p2 holds the profile reading the secured members.
 */
class ViewFx
{
    public static readonly App = 'crm-app'
    public static readonly AppVersion = '1.0.0'
    public static readonly Crm = { id: 'crm', version: '1.0.0' }
    public static readonly Notes = { id: 'notes', version: '1.0.0' }
    public static readonly NotesTodl = 'namespace notes {\n  concept Note { name : string?; }\n}\n'
    public static readonly Note = 'notes.Note'
    public static readonly N1 = 'notes.n1'
    public static readonly CrmTodl = 'namespace crm {\n  concept Account { name : string?; owner : string?; secret : string?; relationship peer -> Account?; relationship boss -> Account?; }\n}\n'
    public static readonly Account = 'crm.Account'
    public static readonly Namespace = 'crm'
    public static readonly Name = 'name'
    public static readonly Owner = 'owner'
    public static readonly Secret = 'secret'
    public static readonly Peer = 'peer'
    public static readonly Boss = 'boss'
    public static readonly Hush = 'hush'
    public static readonly P1 = 'p1'
    public static readonly P2 = 'p2'
    public static readonly Root = 'root'
    public static readonly RootName = 'Root'
    public static readonly UserRole = 'user-role'
    public static readonly UserRoleName = 'User'
    public static readonly Profile = 'secret-readers'
    public static readonly ProfileName = 'Secret readers'
    public static readonly System = 'todl.system'
    public static readonly Unknown = 'nope'
    public static readonly A1 = 'crm.a1'
    public static readonly A2 = 'crm.a2'
    public static readonly A3 = 'crm.a3'
    public static readonly A4 = 'crm.a4'
    public static readonly LocalA3 = 'a3'
    public static readonly A = 'a'
    public static readonly B = 'b'
    public static readonly D = 'd'
    public static readonly F = 'f'
    public static readonly Term = 'todl.Term'
    public static readonly ForeignTerm = 'notes.t1'
    public static readonly ExtraApp = 'extra-app'
    public static readonly Extra = { id: 'extra', version: '1.0.0' }
    public static readonly ExtraTodl = 'namespace extra { concept Thing { name : string?; } }'
    public static readonly Relationship = EdgeKind[EdgeKind.Relationship]
    public static readonly Instance = Tier[Tier.Instance]

    public static Model(): ISecurityModelConfig
    {
        return {
            businessUnits: [{ id: ViewFx.Root, name: ViewFx.RootName }],
            teams: [],
            membership: { claimsMapping: [], overrides: [
                { principalId: ViewFx.P1, homeBusinessUnit: ViewFx.Root, teams: [] },
                { principalId: ViewFx.P2, homeBusinessUnit: ViewFx.Root, teams: [] },
            ] },
            ownershipRules: [{ concept: ViewFx.Account, owner: { kind: OwnershipSourceKind.FromField, value: ViewFx.Owner }, owningBusinessUnit: { kind: OwnershipSourceKind.Fixed, value: ViewFx.Root } }],
            roles: [{ id: ViewFx.UserRole, name: ViewFx.UserRoleName, privileges: [{ action: PrivilegeAction.Read, level: AccessLevel.User, concept: ViewFx.Account }] }],
            roleAssignment: { claimsMapping: [], teamRoles: [], overrides: [
                { principalId: ViewFx.P1, roles: [ViewFx.UserRole] },
                { principalId: ViewFx.P2, roles: [ViewFx.UserRole] },
            ] },
            fieldSecurity: {
                securedFields: [{ concept: ViewFx.Account, field: ViewFx.Secret }, { concept: ViewFx.Account, field: ViewFx.Boss }],
                profiles: [{ id: ViewFx.Profile, name: ViewFx.ProfileName, grants: [
                    { concept: ViewFx.Account, field: ViewFx.Secret, read: true },
                    { concept: ViewFx.Account, field: ViewFx.Boss, read: true },
                ] }],
                profileAssignment: { claimsMapping: [], teamProfiles: [], overrides: [{ principalId: ViewFx.P2, profiles: [ViewFx.Profile] }] },
            },
        }
    }

    public static Principal(id: string): Principal
    {
        return new Principal(id, EnvironmentFixture.TenantId, PrincipalKind.User, new Map(), [])
    }

    /** crm live, the server started with `options`. */
    public static async Run(options: IEnvironmentFixtureOptions, body: (fx: EnvironmentFixture) => Promise<void>): Promise<void>
    {
        const fx = new EnvironmentFixture()
        try
        {
            await fx.Package(ViewFx.Crm.id, ViewFx.Crm.version, ViewFx.CrmTodl)
            await fx.Package(ViewFx.Notes.id, ViewFx.Notes.version, ViewFx.NotesTodl)
            fx.Live(ViewFx.App, ViewFx.AppVersion, [ViewFx.Crm, ViewFx.Notes])
            await fx.Start(options)
            await body(fx)
        }
        finally
        {
            await fx.Dispose()
        }
    }

    /**
     * a1 (p1, secret, peer -> a3, boss -> a3), a2 (p2, secret, boss -> a4), a3 (p1, peer -> a2), a4 (p2): p1 sees a1 and
     * a3, p2 sees a2 and a4.
     */
    public static async SeedAccounts(fx: EnvironmentFixture): Promise<void>
    {
        await fx.Seed([
            ViewFx.Row(ViewFx.A1, ViewFx.P1, true),
            ViewFx.Row(ViewFx.A2, ViewFx.P2, true),
            ViewFx.Row(ViewFx.A3, ViewFx.P1, false),
            ViewFx.Row(ViewFx.A4, ViewFx.P2, false),
        ])
        const transaction = await (await fx.Server.EnvironmentEngine().Engine()).Begin(AccessScope.System)
        transaction.Link(ViewFx.A1, ViewFx.Peer, ViewFx.A3)
        transaction.Link(ViewFx.A1, ViewFx.Boss, ViewFx.A3)
        transaction.Link(ViewFx.A2, ViewFx.Boss, ViewFx.A4)
        transaction.Link(ViewFx.A3, ViewFx.Peer, ViewFx.A2)
        await transaction.Commit()
    }

    private static Row(id: string, owner: string, secret: boolean): { Concept: string; Id: string; Properties: Record<string, string> }
    {
        const properties: Record<string, string> = { [ViewFx.Name]: id, [ViewFx.Owner]: owner }
        if (secret) properties[ViewFx.Secret] = ViewFx.Hush
        return { Concept: ViewFx.Account, Id: id, Properties: properties }
    }

    public static Ids(page: ModelViewPageDto): string[]
    {
        return page.items.map(member => member.id)
    }

    public static Member(page: ModelViewPageDto, id: string): ModelMemberDto
    {
        const member = page.items.find(item => item.id === id)
        assert.ok(member !== undefined, id)
        return member
    }

    /** Every page of the crm view, `pageSize` members each; `between` runs after the first page. */
    public static async Walk(client: PragmaticClient, pageSize: number, between: () => Promise<void>): Promise<string[]>
    {
        let page = await client.ModelView(ViewFx.Crm.id, { pageSize })
        const seen = ViewFx.Ids(page)
        await between()
        while (page.nextCursor !== undefined)
        {
            page = await client.ModelView(ViewFx.Crm.id, { pageSize, cursor: page.nextCursor })
            seen.push(...ViewFx.Ids(page))
        }
        return seen
    }

    public static async CodeOf(attempt: Promise<unknown>): Promise<number | undefined>
    {
        try
        {
            await attempt
        }
        catch (error)
        {
            return (error as { code?: number }).code
        }
        return undefined
    }
}

describe('runtime model/view on the environment engine', () =>
{
    test('model view lists the package\'s visible nodes', async () =>
    {
        await ViewFx.Run({ Identity: true, SecurityModel: ViewFx.Model() }, async fx =>
        {
            await ViewFx.SeedAccounts(fx)
            const client = await fx.Connect(ViewFx.Principal(ViewFx.P1))
            const page = await client.ModelView(ViewFx.Crm.id)
            assert.deepEqual(ViewFx.Ids(page), [ViewFx.A1, ViewFx.A3], 'the depth-hidden accounts of p2 are absent')
            const a3 = ViewFx.Member(page, ViewFx.A3)
            assert.deepEqual({ ...a3, attrs: undefined, edges: undefined },
                { id: ViewFx.A3, kind: ViewFx.Account, localId: ViewFx.LocalA3, namespace: ViewFx.Namespace, tier: ViewFx.Instance, isClass: false, attrs: undefined, edges: undefined })
            assert.equal(a3.attrs[ViewFx.Name], ViewFx.A3)
            assert.equal(a3.attrs[ViewFx.Owner], ViewFx.P1)
            assert.deepEqual(page.provenanceOf, {})
            assert.equal(page.nextCursor, undefined)
        })
    })

    test('hidden member is absent from attrs and edges', async () =>
    {
        await ViewFx.Run({ Identity: true, SecurityModel: ViewFx.Model() }, async fx =>
        {
            await ViewFx.SeedAccounts(fx)
            const plain = ViewFx.Member(await (await fx.Connect(ViewFx.Principal(ViewFx.P1))).ModelView(ViewFx.Crm.id), ViewFx.A1)
            assert.ok(!(ViewFx.Secret in plain.attrs), JSON.stringify(plain.attrs))
            assert.deepEqual(plain.edges, [{ kind: ViewFx.Relationship, via: ViewFx.Peer, to: ViewFx.A3 }], 'the secured boss link is absent')
            const granted = ViewFx.Member(await (await fx.Connect(ViewFx.Principal(ViewFx.P2))).ModelView(ViewFx.Crm.id), ViewFx.A2)
            assert.equal(granted.attrs[ViewFx.Secret], ViewFx.Hush, 'with the profile the secured field reads')
            assert.deepEqual(granted.edges, [{ kind: ViewFx.Relationship, via: ViewFx.Boss, to: ViewFx.A4 }], 'and the secured link is present')
        })
    })

    test('edge to an invisible target is dropped', async () =>
    {
        await ViewFx.Run({ Identity: true, SecurityModel: ViewFx.Model() }, async fx =>
        {
            await ViewFx.SeedAccounts(fx)
            const a3 = ViewFx.Member(await (await fx.Connect(ViewFx.Principal(ViewFx.P1))).ModelView(ViewFx.Crm.id), ViewFx.A3)
            assert.deepEqual(a3.edges, [], 'a3.peer -> a2 (p2\'s) is dropped')
        })
    })

    test('unknown member is InvalidRequest', async () =>
    {
        await ViewFx.Run({}, async fx =>
        {
            const client = await fx.Connect(ViewFx.Principal(ViewFx.P1))
            for (const unknown of [ViewFx.Unknown, ViewFx.System])
            {
                assert.equal(await ViewFx.CodeOf(client.ModelView(unknown)), ErrorCodes.InvalidRequest, unknown)
            }
            assert.equal(await ViewFx.CodeOf(client.ModelView(ViewFx.Unknown, { pageSize: 0 })), ErrorCodes.InvalidRequest, 'the member is checked before the page size')
            assert.equal(await ViewFx.CodeOf(client.ModelView(ViewFx.Crm.id, { pageSize: 0 })), ErrorCodes.InvalidParams, 'a known member with a bad page size')
        })
    })

    test('another package\'s term is not listed', async () =>
    {
        await ViewFx.Run({}, async fx =>
        {
            await fx.Seed([{ Concept: ViewFx.Account, Id: ViewFx.A1 }, { Concept: ViewFx.Term, Id: ViewFx.ForeignTerm, Owner: ViewFx.Notes.id }])
            const client = await fx.Connect(ViewFx.Principal(ViewFx.P1))
            assert.deepEqual(ViewFx.Ids(await client.ModelView(ViewFx.Crm.id)), [ViewFx.A1], 'R53: the crm view lists crm-owned nodes only')
            assert.deepEqual(ViewFx.Ids(await client.ModelView(ViewFx.Notes.id)), [ViewFx.ForeignTerm], 'the owning package lists its term')
        })
    })

    test('an upgrade between pages stales the cursor', async () =>
    {
        await ViewFx.Run({}, async fx =>
        {
            await fx.Seed([ViewFx.B, ViewFx.D].map(id => ({ Concept: ViewFx.Account, Id: id })))
            const client = await fx.Connect(ViewFx.Principal(ViewFx.P1))
            const first = await client.ModelView(ViewFx.Crm.id, { pageSize: 1 })
            assert.ok(first.nextCursor !== undefined)
            await fx.Package(ViewFx.Extra.id, ViewFx.Extra.version, ViewFx.ExtraTodl)
            await fx.Server.EnvironmentEngine().Deliver({ Channel: DeliveryChannel.Deploy, Name: ViewFx.ExtraApp, Packages: [{ model: ViewFx.Extra.id, version: ViewFx.Extra.version }] },
                async () => fx.Live(ViewFx.ExtraApp, ViewFx.AppVersion, [ViewFx.Extra]))
            assert.equal(await ViewFx.CodeOf(client.ModelView(ViewFx.Crm.id, { pageSize: 1, cursor: first.nextCursor })), CursorStaleError.Code)
        })
    })

    test('pages by keyset', async () =>
    {
        await ViewFx.Run({}, async fx =>
        {
            await fx.Seed([...[ViewFx.B, ViewFx.D, ViewFx.F].map(id => ({ Concept: ViewFx.Account, Id: id })), { Concept: ViewFx.Note, Id: ViewFx.N1 }])
            const client = await fx.Connect(ViewFx.Principal(ViewFx.P1))
            // a sorts before page 1's last member: offset paging would repeat b
            const seen = await ViewFx.Walk(client, 1, async () => { await fx.Seed([{ Concept: ViewFx.Account, Id: ViewFx.A }]) })
            assert.deepEqual(seen, [ViewFx.B, ViewFx.D, ViewFx.F], 'no repeat, and the notes package\'s node is not in the crm view')
            assert.deepEqual(ViewFx.Ids(await client.ModelView(ViewFx.Notes.id)), [ViewFx.N1], 'the notes view holds its own node only')
        })
    })

    test('resources are empty at runtime', async () =>
    {
        await ViewFx.Run({}, async fx =>
        {
            await fx.Seed([{ Concept: ViewFx.Account, Id: ViewFx.A1 }])
            const client = await fx.Connect(ViewFx.Principal(ViewFx.P1))
            assert.deepEqual(await client.Resources(ViewFx.A1), [])
            assert.deepEqual(await client.Resources(ViewFx.Unknown), [])
        })
    })
})
