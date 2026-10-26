import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import {
    Repository, Cardinality, toJSON, BlobPackageStore, StoragePackageSink, Cypher,
    PolicyNodeKind, PolicyRefRoot, PolicyCompareOp,
    type PackageDocument, type CompiledPackage,
} from '@pragmatic-tech-ai/todl'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import { AccessLevel, PrivilegeAction, OwnershipSourceKind } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../pragmatic-server.js'
import { TenantPurpose } from '../../tenancy/tenant-purpose.js'
import { AccessPolicySetting } from '../apps/access-policy-setting.js'
import { PpSecurityHarness } from '../cypher/tests/pp-security-harness.js'

/**
 * A bound app owning two packages (hello: the app-private greeting; northwind: a concept the tenant model governs) and
 * depending on a third (base) it does NOT list. The tenant security model governs only northwind.Order.
 */
class GovernanceFixture
{
    public static readonly Plain = 'p1'
    public static readonly Granted = 'p2'
    public static readonly AppName = 'demo'
    public static readonly Greeting = 'hello.greeting'
    public static readonly GreetingQuery = 'MATCH (g:greeting) RETURN g.label AS v'
    public static readonly SecretQuery = 'MATCH (g:greeting) RETURN g.secret AS v'
    public static readonly OrderQuery = 'MATCH (o:Order) RETURN o.label AS v'
    public static readonly ThingQuery = 'MATCH (t:Thing) RETURN t.label AS v'
    private static readonly Version = '1.0.0'
    private static readonly HelloPkg = 'hello'
    private static readonly NorthwindPkg = 'northwind'
    private static readonly BasePkg = 'basepkg'
    private static readonly Order = 'northwind.Order'
    private static readonly Thing = 'base.Thing'
    private static readonly Label = 'label'
    private static readonly Secret = 'secret'
    private static readonly SecretValue = 'hush'
    private static readonly ReaderRole = 'reader'
    private static readonly Profile = 'secret-readers'
    private static readonly ProfileName = 'Secret readers'
    private static readonly Deny = 'deny'
    private static readonly Read = 'read'
    private static readonly PkgPrefix = 'apg-pkgs-'
    private static readonly AppsPrefix = 'apg-apps-'
    private static readonly IdPrefix = 'apg-id-'
    private static readonly ManifestFile = 'application.json'
    private static readonly SourceSuffix = '.todl'

    private readonly packages = mkdtempSync(join(tmpdir(), GovernanceFixture.PkgPrefix))
    private readonly apps = mkdtempSync(join(tmpdir(), GovernanceFixture.AppsPrefix))
    private readonly identityRoot = mkdtempSync(join(tmpdir(), GovernanceFixture.IdPrefix))
    private server: PragmaticServer | undefined

    public async Setup(): Promise<PragmaticServer>
    {
        PpSecurityHarness.SetKey()
        await this.Persist(GovernanceFixture.BasePkg, GovernanceFixture.BaseRepo(), [])
        await this.Persist(GovernanceFixture.HelloPkg, GovernanceFixture.HelloRepo(), [GovernanceFixture.BasePkg])
        await this.Persist(GovernanceFixture.NorthwindPkg, GovernanceFixture.NorthwindRepo(), [])
        mkdirSync(join(this.apps, GovernanceFixture.AppName))
        writeFileSync(join(this.apps, GovernanceFixture.AppName, GovernanceFixture.ManifestFile), JSON.stringify({
            name: GovernanceFixture.AppName, version: GovernanceFixture.Version,
            packages: [
                { id: GovernanceFixture.HelloPkg, version: GovernanceFixture.Version },
                { id: GovernanceFixture.NorthwindPkg, version: GovernanceFixture.Version },
            ],
        }))
        this.server = new PragmaticServer({
            packagesRoot: this.packages, applicationsRoot: this.apps, purpose: TenantPurpose.Runtime,
            identity: PpSecurityHarness.Identity(this.identityRoot),
        })
        await this.server.Start()
        await PpSecurityHarness.Seed(this.server, GovernanceFixture.Model())
        return this.server
    }

    public async Graph(principal: string): Promise<IGraphQuery>
    {
        return this.server!.GraphForPragmaticApp(PpSecurityHarness.Context(principal), GovernanceFixture.AppName)
    }

    /** An app-policy rule denying every read of hello.greeting whose label is `label`. */
    public DenyGreeting(label: string): void
    {
        const rules = [{
            effect: GovernanceFixture.Deny, action: GovernanceFixture.Read,
            predicate: {
                kind: PolicyNodeKind.Compare, op: PolicyCompareOp.Eq,
                left: { kind: PolicyNodeKind.Ref, root: PolicyRefRoot.Entity, member: GovernanceFixture.Label },
                right: { kind: PolicyNodeKind.Literal, value: label },
            },
        }]
        writeFileSync(join(this.apps, GovernanceFixture.AppName, AccessPolicySetting.PolicyFile), JSON.stringify({ [GovernanceFixture.Greeting]: rules }))
    }

    public static Column(graph: IGraphQuery, query: string): string[]
    {
        return Cypher.CypherEngine.OverQuery(graph).Execute(query).Rows
            .map(r => (r[0] instanceof Cypher.ScalarValue && r[0].Value !== null ? String(r[0].Value) : '')).sort()
    }

    public async Dispose(): Promise<void>
    {
        await this.server?.Dispose()
        rmSync(this.packages, { recursive: true, force: true })
        rmSync(this.apps, { recursive: true, force: true })
        rmSync(this.identityRoot, { recursive: true, force: true })
        PpSecurityHarness.ClearKey()
    }

    /** Governs ONLY northwind.Order (privilege + ownership rule); p2 holds an org-level read role, p1 holds none. The greeting secret field is field-secured. */
    private static Model(): ISecurityModelConfig
    {
        const membership = { claimsMapping: [], overrides: [
            { principalId: GovernanceFixture.Plain, homeBusinessUnit: PpSecurityHarness.SalesBu, teams: [] },
            { principalId: GovernanceFixture.Granted, homeBusinessUnit: PpSecurityHarness.SalesBu, teams: [] },
        ] }
        return {
            businessUnits: [{ id: PpSecurityHarness.RootBu, name: 'Root' }, { id: PpSecurityHarness.SalesBu, name: 'Sales', parent: PpSecurityHarness.RootBu }],
            teams: [],
            membership,
            ownershipRules: [{ concept: GovernanceFixture.Order, owningBusinessUnit: { kind: OwnershipSourceKind.FromField, value: PpSecurityHarness.OwningBuField } }],
            roles: [{ id: GovernanceFixture.ReaderRole, name: 'Reader', privileges: [{ action: PrivilegeAction.Read, concept: GovernanceFixture.Order, level: AccessLevel.Organization }] }],
            roleAssignment: { claimsMapping: [], teamRoles: [], overrides: [{ principalId: GovernanceFixture.Granted, roles: [GovernanceFixture.ReaderRole] }] },
            fieldSecurity: {
                securedFields: [{ concept: GovernanceFixture.Greeting, field: GovernanceFixture.Secret }],
                profiles: [{ id: GovernanceFixture.Profile, name: GovernanceFixture.ProfileName, grants: [] }],
                profileAssignment: { claimsMapping: [], teamProfiles: [], overrides: [] },
            },
        }
    }

    private async Persist(id: string, repo: Repository, dependencies: string[]): Promise<void>
    {
        const doc = { ...(toJSON(repo) as PackageDocument), dependencies: dependencies.map(d => ({ id: d, version: GovernanceFixture.Version })) } as PackageDocument
        const pkg: CompiledPackage = {
            id, version: GovernanceFixture.Version, document: doc, fullDocument: doc,
            sources: [{ uri: id + GovernanceFixture.SourceSuffix, text: '' }], classes: [],
        }
        await new BlobPackageStore(new StoragePackageSink(new NodeFsStorage(this.packages))).persist(pkg)
    }

    private static HelloRepo(): Repository
    {
        const repo = new Repository()
        repo.builder()
            .setNamespace('hello')
            .defineConcept(GovernanceFixture.Greeting)
            .addField(GovernanceFixture.Greeting, GovernanceFixture.Label, 'string', Cardinality.Optional)
            .addField(GovernanceFixture.Greeting, GovernanceFixture.Secret, 'string', Cardinality.Optional)
            .assertInstance(GovernanceFixture.Greeting, 'hello.g1')
            .setField('hello.g1', GovernanceFixture.Label, 'G1')
            .setField('hello.g1', GovernanceFixture.Secret, GovernanceFixture.SecretValue)
            .assertInstance(GovernanceFixture.Greeting, 'hello.g2')
            .setField('hello.g2', GovernanceFixture.Label, 'G2')
            .setField('hello.g2', GovernanceFixture.Secret, GovernanceFixture.SecretValue)
            .commit()
        return repo
    }

    private static NorthwindRepo(): Repository
    {
        const repo = new Repository()
        repo.builder()
            .setNamespace('northwind')
            .defineConcept(GovernanceFixture.Order)
            .addField(GovernanceFixture.Order, PpSecurityHarness.OwningBuField, 'string', Cardinality.Optional)
            .addField(GovernanceFixture.Order, GovernanceFixture.Label, 'string', Cardinality.Optional)
            .assertInstance(GovernanceFixture.Order, 'northwind.o1')
            .setField('northwind.o1', PpSecurityHarness.OwningBuField, PpSecurityHarness.SalesBu)
            .setField('northwind.o1', GovernanceFixture.Label, 'O1')
            .commit()
        return repo
    }

    private static BaseRepo(): Repository
    {
        const repo = new Repository()
        repo.builder()
            .setNamespace('base')
            .defineConcept(GovernanceFixture.Thing)
            .addField(GovernanceFixture.Thing, GovernanceFixture.Label, 'string', Cardinality.Optional)
            .assertInstance(GovernanceFixture.Thing, 'base.t1')
            .setField('base.t1', GovernanceFixture.Label, 'T1')
            .commit()
        return repo
    }
}

class GovernanceRun
{
    public static async With(body: (fx: GovernanceFixture) => Promise<void>): Promise<void>
    {
        const fx = new GovernanceFixture()
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
}

test('app-private: a principal with no role reads its own ungoverned concept', async () =>
{
    await GovernanceRun.With(async fx =>
    {
        const graph = await fx.Graph(GovernanceFixture.Plain)
        assert.deepEqual(GovernanceFixture.Column(graph, GovernanceFixture.GreetingQuery), ['G1', 'G2'])
    })
})

test('org governance intact: the same principal reads none of a model-governed concept it lacks the grant for', async () =>
{
    await GovernanceRun.With(async fx =>
    {
        const plain = await fx.Graph(GovernanceFixture.Plain)
        assert.deepEqual(GovernanceFixture.Column(plain, GovernanceFixture.OrderQuery), [])
        const granted = await fx.Graph(GovernanceFixture.Granted)
        assert.deepEqual(GovernanceFixture.Column(granted, GovernanceFixture.OrderQuery), ['O1'], 'the grant still works (governance, not blanket denial)')
    })
})

test('shared-concept escalation: an app that also declares a model-governed concept does not read it without the grant', async () =>
{
    await GovernanceRun.With(async fx =>
    {
        // northwind.Order lives in the app's OWN manifest.packages yet the model references it, so it is not app-private.
        const graph = await fx.Graph(GovernanceFixture.Plain)
        assert.deepEqual(GovernanceFixture.Column(graph, GovernanceFixture.OrderQuery), [])
    })
})

test('predicate still governs: an app-policy deny over an app-private concept yields nothing for that instance', async () =>
{
    await GovernanceRun.With(async fx =>
    {
        const before = await fx.Graph(GovernanceFixture.Plain)
        assert.deepEqual(GovernanceFixture.Column(before, GovernanceFixture.GreetingQuery), ['G1', 'G2'])
        fx.DenyGreeting('G1')
        const after = await fx.Graph(GovernanceFixture.Plain)
        assert.deepEqual(GovernanceFixture.Column(after, GovernanceFixture.GreetingQuery), ['G2'])
    })
})

test('transitive dependency: a concept from a package the app depends on but does not list stays denied', async () =>
{
    await GovernanceRun.With(async fx =>
    {
        const graph = await fx.Graph(GovernanceFixture.Plain)
        assert.deepEqual(GovernanceFixture.Column(graph, GovernanceFixture.ThingQuery), [])
    })
})

test('field mask intact: a secured field on an app-private concept is still masked', async () =>
{
    await GovernanceRun.With(async fx =>
    {
        const graph = await fx.Graph(GovernanceFixture.Plain)
        assert.deepEqual(GovernanceFixture.Column(graph, GovernanceFixture.SecretQuery), ['', ''])
    })
})
