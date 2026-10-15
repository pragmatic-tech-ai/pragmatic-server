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
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../../pragmatic-server.js'
import { TenantPurpose } from '../../../tenancy/tenant-purpose.js'
import { AccessPolicySetting } from '../../apps/access-policy-setting.js'
import { PpSecurityHarness } from './pp-security-harness.js'

class DepthFixture
{
    private static readonly Id = 'shop'
    private static readonly Version = '1.0.0'
    private static readonly PkgPrefix = 'gfad-pkgs-'
    private static readonly AppsPrefix = 'gfad-apps-'
    private static readonly IdPrefix = 'gfad-id-'
    private static readonly AppName = 'demo'
    private static readonly ManifestFile = 'application.json'
    private static readonly SourceSuffix = '.todl'
    private static readonly LabelsQuery = 'MATCH (w:Widget) RETURN w.label AS label'
    private static readonly EdgeQuery = 'MATCH (a:Widget)-[:next]->(b:Widget) RETURN a.label AS label'
    private static readonly Label = 'label'
    private static readonly Link = 'next'
    private static readonly Deny = 'deny'
    private static readonly Read = 'read'
    private static readonly Principal = 'p1'
    public static readonly SalesLabel = 'S1'
    public static readonly SalesLabel2 = 'S2'
    public static readonly RootLabel = 'R1'

    private readonly packages = mkdtempSync(join(tmpdir(), DepthFixture.PkgPrefix))
    private readonly apps = mkdtempSync(join(tmpdir(), DepthFixture.AppsPrefix))
    private readonly identityRoot = mkdtempSync(join(tmpdir(), DepthFixture.IdPrefix))
    private server: PragmaticServer | undefined

    public static get Name(): string
    {
        return DepthFixture.AppName
    }

    /** Boots an identity-configured runtime server; seeds the model unless it is undefined (state 2). */
    public async Setup(model: ISecurityModelConfig | undefined): Promise<PragmaticServer>
    {
        PpSecurityHarness.SetKey()
        const doc = toJSON(DepthFixture.Repo()) as PackageDocument
        const pkg: CompiledPackage = {
            id: DepthFixture.Id, version: DepthFixture.Version, document: doc, fullDocument: doc,
            sources: [{ uri: DepthFixture.Id + DepthFixture.SourceSuffix, text: '' }], classes: [],
        }
        await new BlobPackageStore(new StoragePackageSink(new NodeFsStorage(this.packages))).persist(pkg)
        mkdirSync(join(this.apps, DepthFixture.AppName))
        writeFileSync(join(this.apps, DepthFixture.AppName, DepthFixture.ManifestFile), JSON.stringify({
            name: DepthFixture.AppName, version: DepthFixture.Version,
            packages: [{ id: DepthFixture.Id, version: DepthFixture.Version }],
        }))
        this.server = new PragmaticServer({
            packagesRoot: this.packages, applicationsRoot: this.apps, purpose: TenantPurpose.Runtime,
            identity: PpSecurityHarness.Identity(this.identityRoot),
        })
        await this.server.Start()
        if (model !== undefined)
        {
            await PpSecurityHarness.Seed(this.server, model)
        }
        return this.server
    }

    public static Context()
    {
        return PpSecurityHarness.Context(DepthFixture.Principal)
    }

    public static Bu(): ISecurityModelConfig
    {
        return PpSecurityHarness.BuSecurityModel(DepthFixture.Principal)
    }

    public static Org(): ISecurityModelConfig
    {
        return PpSecurityHarness.OrgSecurityModel(DepthFixture.Principal)
    }

    public DenyLabel(label: string): void
    {
        const rules = [{
            effect: DepthFixture.Deny, action: DepthFixture.Read,
            predicate: {
                kind: PolicyNodeKind.Compare, op: PolicyCompareOp.Eq,
                left: { kind: PolicyNodeKind.Ref, root: PolicyRefRoot.Entity, member: DepthFixture.Label },
                right: { kind: PolicyNodeKind.Literal, value: label },
            },
        }]
        writeFileSync(join(this.apps, DepthFixture.AppName, AccessPolicySetting.PolicyFile), JSON.stringify({ [PpSecurityHarness.Concept]: rules }))
    }

    public static Labels(graph: IGraphQuery): string[]
    {
        return DepthFixture.Column(graph, DepthFixture.LabelsQuery)
    }

    public static EdgeSources(graph: IGraphQuery): string[]
    {
        return DepthFixture.Column(graph, DepthFixture.EdgeQuery)
    }

    public async Dispose(): Promise<void>
    {
        await this.server?.Dispose()
        rmSync(this.packages, { recursive: true, force: true })
        rmSync(this.apps, { recursive: true, force: true })
        rmSync(this.identityRoot, { recursive: true, force: true })
        PpSecurityHarness.ClearKey()
    }

    private static Column(graph: IGraphQuery, query: string): string[]
    {
        return Cypher.CypherEngine.OverQuery(graph).Execute(query).Rows
            .map(r => (r[0] instanceof Cypher.ScalarValue ? String(r[0].Value) : '')).sort()
    }

    private static Repo(): Repository
    {
        const repo = new Repository()
        repo.builder()
            .defineConcept(PpSecurityHarness.Concept)
            .addField(PpSecurityHarness.Concept, PpSecurityHarness.OwningBuField, 'string', Cardinality.Optional)
            .addField(PpSecurityHarness.Concept, DepthFixture.Label, 'string', Cardinality.Optional)
            .addConceptRelationship(PpSecurityHarness.Concept, DepthFixture.Link, [PpSecurityHarness.Concept], Cardinality.Optional, 'prev')
            .setNamespace('shop')
            .assertInstance(PpSecurityHarness.Concept, 'shop.s1')
            .setField('shop.s1', PpSecurityHarness.OwningBuField, PpSecurityHarness.SalesBu)
            .setField('shop.s1', DepthFixture.Label, DepthFixture.SalesLabel)
            .assertInstance(PpSecurityHarness.Concept, 'shop.s2')
            .setField('shop.s2', PpSecurityHarness.OwningBuField, PpSecurityHarness.SalesBu)
            .setField('shop.s2', DepthFixture.Label, DepthFixture.SalesLabel2)
            .assertInstance(PpSecurityHarness.Concept, 'shop.r1')
            .setField('shop.r1', PpSecurityHarness.OwningBuField, PpSecurityHarness.RootBu)
            .setField('shop.r1', DepthFixture.Label, DepthFixture.RootLabel)
            .addRelationship('shop.s1', DepthFixture.Link, 'shop.r1')
            .commit()
        return repo
    }
}

test('state 1: BusinessUnit depth keeps sales-owned widgets and drops root-owned ones', async () =>
{
    const fx = new DepthFixture()
    try
    {
        const server = await fx.Setup(DepthFixture.Bu())
        const graph = await server.GraphForPragmaticApp(DepthFixture.Context(), DepthFixture.Name)
        assert.deepEqual(DepthFixture.Labels(graph), [DepthFixture.SalesLabel, DepthFixture.SalesLabel2])
    }
    finally
    {
        await fx.Dispose()
    }
})

test('state 1: an edge from a visible node to a depth-denied node is not traversable', async () =>
{
    const fx = new DepthFixture()
    try
    {
        const server = await fx.Setup(DepthFixture.Bu())
        const graph = await server.GraphForPragmaticApp(DepthFixture.Context(), DepthFixture.Name)
        assert.deepEqual(DepthFixture.EdgeSources(graph), [])
    }
    finally
    {
        await fx.Dispose()
    }
})

test('compose: a predicate deny still drops an instance the depth axis allows', async () =>
{
    const fx = new DepthFixture()
    try
    {
        const server = await fx.Setup(DepthFixture.Org())
        const ctx = DepthFixture.Context()
        const before = await server.GraphForPragmaticApp(ctx, DepthFixture.Name)
        assert.deepEqual(DepthFixture.Labels(before), [DepthFixture.RootLabel, DepthFixture.SalesLabel, DepthFixture.SalesLabel2])
        assert.deepEqual(DepthFixture.EdgeSources(before), [DepthFixture.SalesLabel], 'the edge exists when depth allows both ends')
        fx.DenyLabel(DepthFixture.SalesLabel)
        const after = await server.GraphForPragmaticApp(ctx, DepthFixture.Name)
        assert.deepEqual(DepthFixture.Labels(after), [DepthFixture.RootLabel, DepthFixture.SalesLabel2])
    }
    finally
    {
        await fx.Dispose()
    }
})

test('state 2: identity configured but no SecurityModel denies every widget', async () =>
{
    const fx = new DepthFixture()
    try
    {
        const server = await fx.Setup(undefined)
        const graph = await server.GraphForPragmaticApp(DepthFixture.Context(), DepthFixture.Name)
        assert.deepEqual(DepthFixture.Labels(graph), [])
    }
    finally
    {
        await fx.Dispose()
    }
})
