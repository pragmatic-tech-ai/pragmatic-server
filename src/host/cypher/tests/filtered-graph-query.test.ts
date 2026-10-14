import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import {
    Repository, Cardinality, toJSON, BlobPackageStore, StoragePackageSink, StoragePackageSource,
    PolicyNodeKind, PolicyRefRoot, PolicyCompareOp,
    type PackageDocument, type CompiledPackage, type IInstanceFilter,
} from '@pragmatic-tech-ai/todl'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import { AccessContext, Action, Principal, PrincipalKind, Tenant, TenantKind } from '@pragmatic-tech-ai/todl-identity'
import { PolicyCatalog, IdentityEnforcement, FusionAccessPolicy } from '@pragmatic-tech-ai/todl-identity-engine'
import { RuntimeAppGraph } from '../runtime-app-graph.js'
import { FilteredGraphQuery } from '../filtered-graph-query.js'

class Fixture
{
    public static readonly Id = 'acme'
    public static readonly Version = '1.0.0'
    public static readonly Prefix = 'filtered-'
    public static readonly SourceSuffix = '.todl'
    public static readonly Secret = 'acme.Secret'
    public static readonly Doc = 'acme.Doc'
    public static readonly Link = 'link'
    public static readonly Code = 'code'
    public static readonly Back = 'linkedFrom'
    public static readonly Hidden = 'hidden'
    public static readonly Open = 'open'
    public static readonly SecretHidden = 'acme.s1'
    public static readonly SecretOpen = 'acme.s2'
    public static readonly DocA = 'acme.d1'
    public static readonly DocB = 'acme.d2'
    public static readonly EffectDeny = 'deny'
    public static readonly ActionRead = 'read'
    public static readonly TenantId = 't1'
    public static readonly AppName = 'x'
    public static readonly AppVersion = '1'

    public readonly Dir = mkdtempSync(join(tmpdir(), Fixture.Prefix))

    public static Ids(ms: readonly { node: { id: string } }[]): string[]
    {
        return ms.map(m => m.node.id).sort()
    }

    public async Build(): Promise<IGraphQuery>
    {
        const doc = toJSON(Fixture.Repo()) as PackageDocument
        const pkg: CompiledPackage = {
            id: Fixture.Id, version: Fixture.Version, document: doc, fullDocument: doc,
            sources: [{ uri: Fixture.Id + Fixture.SourceSuffix, text: '' }], classes: [],
        }
        await new BlobPackageStore(new StoragePackageSink(new NodeFsStorage(this.Dir))).persist(pkg)
        return await RuntimeAppGraph.BuildQuery(
            new StoragePackageSource(new NodeFsStorage(this.Dir)),
            { name: Fixture.AppName, version: Fixture.AppVersion, packages: [{ id: Fixture.Id, version: Fixture.Version }] })
    }

    public Filter(): IInstanceFilter
    {
        const rules = JSON.stringify([{
            effect: Fixture.EffectDeny, action: Fixture.ActionRead,
            predicate: {
                kind: PolicyNodeKind.Compare, op: PolicyCompareOp.Eq,
                left: { kind: PolicyNodeKind.Ref, root: PolicyRefRoot.Entity, member: Fixture.Code },
                right: { kind: PolicyNodeKind.Literal, value: Fixture.Hidden },
            },
        }])
        const catalog = PolicyCatalog.FromPolicies([{ concept: Fixture.Secret, rulesJson: rules }])
        const principal = new Principal('u1', Fixture.TenantId, PrincipalKind.User, new Map(), [])
        const ctx = new AccessContext(principal, new Tenant(Fixture.TenantId, TenantKind.Saas, 'Acme'), [], new FusionAccessPolicy(catalog))
        return IdentityEnforcement.Over(catalog, ctx, Action.Read).InstanceFilter()
    }

    public Dispose(): void
    {
        rmSync(this.Dir, { recursive: true, force: true })
    }

    private static Repo(): Repository
    {
        const repo = new Repository()
        repo.builder()
            .defineConcept('acme.Secret')
            .defineConcept('acme.Doc')
            .addField('acme.Secret', Fixture.Code, 'string', Cardinality.Optional)
            .addConceptRelationship('acme.Doc', Fixture.Link, ['acme.Secret'], Cardinality.Optional, Fixture.Back)
            .assertInstance('acme.Secret', Fixture.SecretHidden)
            .setField(Fixture.SecretHidden, Fixture.Code, Fixture.Hidden)
            .assertInstance('acme.Secret', Fixture.SecretOpen)
            .setField(Fixture.SecretOpen, Fixture.Code, Fixture.Open)
            .assertInstance('acme.Doc', Fixture.DocA)
            .assertInstance('acme.Doc', Fixture.DocB)
            .addRelationship(Fixture.DocA, Fixture.Link, Fixture.SecretHidden)
            .addRelationship(Fixture.DocB, Fixture.Link, Fixture.SecretOpen)
            .commit()
        return repo
    }
}

test('denied instances are hidden from listing, reflection and edges', async () =>
{
    const fx = new Fixture()
    try
    {
        const inner = await fx.Build()
        assert.ok(Fixture.Ids(inner.AllInstances()).includes(Fixture.SecretHidden), 'precondition: unfiltered graph has the secret')
        assert.deepEqual(Fixture.Ids(inner.Refs(Fixture.DocA, Fixture.Link)), [Fixture.SecretHidden], 'precondition: edge exists')
        const q = new FilteredGraphQuery(inner, fx.Filter())

        assert.ok(!Fixture.Ids(q.AllInstances()).includes(Fixture.SecretHidden))
        assert.ok(Fixture.Ids(q.AllInstances()).includes(Fixture.SecretOpen))
        assert.deepEqual(Fixture.Ids(q.InstancesOf(Fixture.Secret)), [Fixture.SecretOpen])
        assert.equal(q.Reflect(Fixture.SecretHidden), undefined)
        assert.equal(q.Reflect(Fixture.SecretOpen)?.node.id, Fixture.SecretOpen)

        // an allowed Doc's ref to a denied Secret is not traversable; the open one still is
        assert.deepEqual(Fixture.Ids(q.Refs(Fixture.DocA, Fixture.Link)), [])
        assert.deepEqual(Fixture.Ids(q.Refs(Fixture.DocB, Fixture.Link)), [Fixture.SecretOpen])
        assert.ok(Fixture.Ids(q.Referrers(Fixture.SecretOpen)).includes(Fixture.DocB))
        assert.deepEqual(Fixture.Ids(q.Referrers(Fixture.SecretHidden)), [])
        assert.deepEqual(Fixture.Ids(q.Search(Fixture.Hidden)), [])
        assert.equal(q.Concepts().length, inner.Concepts().length)
        assert.deepEqual(Fixture.Ids(q.InstancesOf(Fixture.Doc)), [Fixture.DocA, Fixture.DocB])
    }
    finally { fx.Dispose() }
})
