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
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../../pragmatic-server.js'
import { TenantPurpose } from '../../../tenancy/tenant-purpose.js'
import { AccessPolicySetting } from '../../apps/access-policy-setting.js'

class GraphForAppFixture
{
    private static readonly Id = 'shop'
    private static readonly Version = '1.0.0'
    private static readonly PkgPrefix = 'gfa-pkgs-'
    private static readonly AppsPrefix = 'gfa-apps-'
    private static readonly AppName = 'demo'
    private static readonly AppVersion = '1.0.0'
    private static readonly ManifestFile = 'application.json'
    private static readonly SourceSuffix = '.todl'
    private static readonly BaseGraphFor = 'BaseGraphFor'
    private static readonly LabelsQuery = 'MATCH (w:Widget) RETURN w.label AS label'
    private static readonly Concept = 'Widget'
    private static readonly Label = 'label'
    public static readonly Hidden = 'Bye'
    public static readonly Visible = 'Hi'
    private static readonly Deny = 'deny'
    private static readonly Read = 'read'
    private static readonly OpenPolicy = '{}'

    private readonly packages = mkdtempSync(join(tmpdir(), GraphForAppFixture.PkgPrefix))
    private readonly apps = mkdtempSync(join(tmpdir(), GraphForAppFixture.AppsPrefix))
    private server: PragmaticServer | undefined

    public static Permissive(): AccessContext
    {
        const tenant = new Tenant('t1', TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('p1', 't1', PrincipalKind.User, new Map(), [])
        const grants = [new Grant('p1', Role.Owner, new ResourceRef(ResourceKind.Tenant, 't1', []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    public async Setup(): Promise<PragmaticServer>
    {
        const doc = toJSON(GraphForAppFixture.Repo()) as PackageDocument
        const pkg: CompiledPackage = {
            id: GraphForAppFixture.Id, version: GraphForAppFixture.Version, document: doc, fullDocument: doc,
            sources: [{ uri: GraphForAppFixture.Id + GraphForAppFixture.SourceSuffix, text: '' }], classes: [],
        }
        await new BlobPackageStore(new StoragePackageSink(new NodeFsStorage(this.packages))).persist(pkg)
        mkdirSync(join(this.apps, GraphForAppFixture.AppName))
        writeFileSync(join(this.apps, GraphForAppFixture.AppName, GraphForAppFixture.ManifestFile), JSON.stringify({
            name: GraphForAppFixture.AppName, version: GraphForAppFixture.AppVersion,
            packages: [{ id: GraphForAppFixture.Id, version: GraphForAppFixture.Version }],
        }))
        this.server = new PragmaticServer({ packagesRoot: this.packages, applicationsRoot: this.apps, purpose: TenantPurpose.Runtime })
        return this.server
    }

    public DenyHidden(): void
    {
        const rules = [{
            effect: GraphForAppFixture.Deny, action: GraphForAppFixture.Read,
            predicate: {
                kind: PolicyNodeKind.Compare, op: PolicyCompareOp.Eq,
                left: { kind: PolicyNodeKind.Ref, root: PolicyRefRoot.Entity, member: GraphForAppFixture.Label },
                right: { kind: PolicyNodeKind.Literal, value: GraphForAppFixture.Hidden },
            },
        }]
        this.WritePolicy(JSON.stringify({ [GraphForAppFixture.Concept]: rules }))
    }

    public OpenPolicy(): void
    {
        this.WritePolicy(GraphForAppFixture.OpenPolicy)
    }

    public static Labels(graph: IGraphQuery): string[]
    {
        return Cypher.CypherEngine.OverQuery(graph).Execute(GraphForAppFixture.LabelsQuery).Rows
            .map(r => (r[0] instanceof Cypher.ScalarValue ? String(r[0].Value) : '')).sort()
    }

    public static BaseOf(server: PragmaticServer): Promise<IGraphQuery>
    {
        return (server as any)[GraphForAppFixture.BaseGraphFor](GraphForAppFixture.AppName)
    }

    public static get Name(): string
    {
        return GraphForAppFixture.AppName
    }

    public async Dispose(): Promise<void>
    {
        await this.server?.Dispose()
        rmSync(this.packages, { recursive: true, force: true })
        rmSync(this.apps, { recursive: true, force: true })
    }

    private WritePolicy(text: string): void
    {
        writeFileSync(join(this.apps, GraphForAppFixture.AppName, AccessPolicySetting.PolicyFile), text)
    }

    private static Repo(): Repository
    {
        const repo = new Repository()
        repo.builder()
            .defineConcept('Widget')
            .addField('Widget', GraphForAppFixture.Label, 'string', Cardinality.Optional)
            .setNamespace('shop')
            .assertInstance('Widget', 'shop.hero')
            .setField('shop.hero', GraphForAppFixture.Label, GraphForAppFixture.Visible)
            .assertInstance('Widget', 'shop.tail')
            .setField('shop.tail', GraphForAppFixture.Label, GraphForAppFixture.Hidden)
            .commit()
        return repo
    }
}

test('GraphForPragmaticApp applies the live access-policy setting over a cached base graph', async () =>
{
    const fx = new GraphForAppFixture()
    try
    {
        const server = await fx.Setup()
        const ctx = GraphForAppFixture.Permissive()
        fx.DenyHidden()
        const denied = await server.GraphForPragmaticApp(ctx, GraphForAppFixture.Name)
        assert.deepEqual(GraphForAppFixture.Labels(denied), [GraphForAppFixture.Visible])

        fx.OpenPolicy()
        const open = await server.GraphForPragmaticApp(ctx, GraphForAppFixture.Name)
        assert.deepEqual(GraphForAppFixture.Labels(open), [GraphForAppFixture.Hidden, GraphForAppFixture.Visible])

        const first = await GraphForAppFixture.BaseOf(server)
        const second = await GraphForAppFixture.BaseOf(server)
        assert.equal(first, second, 'base graph is cached per app')
    }
    finally
    {
        await fx.Dispose()
    }
})
