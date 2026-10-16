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
import { PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import { ShareSubjectKind, ShareStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { IDataSourceAdapter, ExternalFieldValue } from '@pragmatic-tech-ai/todl'
import { DataSourceKind, WriteOperationKind } from '@pragmatic-tech-ai/todl'
import { PragmaticServer } from '../../../pragmatic-server.js'
import { TenantPurpose } from '../../../tenancy/tenant-purpose.js'
import { NodePlatform } from '../../../platform/node-platform.js'
import { AccessPolicySetting } from '../../apps/access-policy-setting.js'
import { BuiltinAdapterFactory } from '../../connectors/builtin-adapter-factory.js'
import { BuiltinBindings } from '../../connectors/builtin-bindings.js'
import { BuiltinStoreEngine } from '../../connectors/builtin-store-engine.js'
import { PpSecurityHarness } from './pp-security-harness.js'

class RecordSharingFixture
{
    private static readonly Id = 'shop'
    private static readonly Version = '1.0.0'
    private static readonly PkgPrefix = 'rsh-pkgs-'
    private static readonly AppsPrefix = 'rsh-apps-'
    private static readonly IdPrefix = 'rsh-id-'
    private static readonly AppName = 'demo'
    private static readonly ManifestFile = 'application.json'
    private static readonly SourceSuffix = '.todl'
    private static readonly IdField = 'id'
    private static readonly DataDir = 'data'
    private static readonly Qualified = 'shop.Widget'
    private static readonly OwningBu = PpSecurityHarness.OwningBuField
    private static readonly Label = 'label'
    private static readonly Secret = 'secret'
    private static readonly SecretValue = 'hush'
    private static readonly Deny = 'deny'
    private static readonly Read = 'read'
    private static readonly Profile = 'secret-readers'
    private static readonly ProfileName = 'Secret readers'
    public static readonly Query = 'MATCH (w:Widget) RETURN w.label AS label, w.secret AS secret'
    public static readonly Principal = 'p1'
    public static readonly Other = 'p2'
    /** Sales-owned: visible by depth + predicate. */
    public static readonly VisibleLabel = 'S1'
    /** Root-owned (depth denies) AND label-denied by the predicate: shared with the principal. */
    public static readonly SharedLabel = 'SHARED'
    /** Root-owned (depth denies), unshared. */
    public static readonly HiddenLabel = 'R1'
    public static readonly SharedRecordId = 'rec-shared'

    private readonly packages = mkdtempSync(join(tmpdir(), RecordSharingFixture.PkgPrefix))
    private readonly apps = mkdtempSync(join(tmpdir(), RecordSharingFixture.AppsPrefix))
    private readonly identityRoot = mkdtempSync(join(tmpdir(), RecordSharingFixture.IdPrefix))
    private server: PragmaticServer | undefined
    private store: IDataSourceAdapter | undefined

    public static get Name(): string
    {
        return RecordSharingFixture.AppName
    }

    public async Setup(): Promise<PragmaticServer>
    {
        PpSecurityHarness.SetKey()
        const doc = toJSON(RecordSharingFixture.Repo()) as PackageDocument
        const pkg: CompiledPackage = {
            id: RecordSharingFixture.Id, version: RecordSharingFixture.Version, document: doc, fullDocument: doc,
            sources: [{ uri: RecordSharingFixture.Id + RecordSharingFixture.SourceSuffix, text: '' }], classes: [],
        }
        await new BlobPackageStore(new StoragePackageSink(new NodeFsStorage(this.packages))).persist(pkg)
        mkdirSync(join(this.apps, RecordSharingFixture.AppName))
        writeFileSync(join(this.apps, RecordSharingFixture.AppName, RecordSharingFixture.ManifestFile), JSON.stringify({
            name: RecordSharingFixture.AppName, version: RecordSharingFixture.Version,
            packages: [{ id: RecordSharingFixture.Id, version: RecordSharingFixture.Version }],
        }))
        writeFileSync(join(this.apps, RecordSharingFixture.AppName, AccessPolicySetting.PolicyFile), JSON.stringify({ [RecordSharingFixture.Qualified]: [{
            effect: RecordSharingFixture.Deny, action: RecordSharingFixture.Read,
            predicate: {
                kind: PolicyNodeKind.Compare, op: PolicyCompareOp.Eq,
                left: { kind: PolicyNodeKind.Ref, root: PolicyRefRoot.Entity, member: RecordSharingFixture.Label },
                right: { kind: PolicyNodeKind.Literal, value: RecordSharingFixture.SharedLabel },
            },
        }] }))
        this.server = new PragmaticServer({
            packagesRoot: this.packages, applicationsRoot: this.apps, purpose: TenantPurpose.Runtime,
            builtinStoreEngine: BuiltinStoreEngine.Document,
            identity: PpSecurityHarness.Identity(this.identityRoot),
        })
        await this.server.Start()
        await PpSecurityHarness.Seed(this.server, RecordSharingFixture.Model())
        await this.Put('rec-visible', PpSecurityHarness.SalesBu, RecordSharingFixture.VisibleLabel)
        await this.Put(RecordSharingFixture.SharedRecordId, PpSecurityHarness.RootBu, RecordSharingFixture.SharedLabel)
        await this.Put('rec-hidden', PpSecurityHarness.RootBu, RecordSharingFixture.HiddenLabel)
        return this.server
    }

    /** Writes a record into the app's built-in store (where default-bound concepts live); the key is the record id. */
    private async Put(key: string, owningBu: string, label: string): Promise<void>
    {
        const fields: Record<string, ExternalFieldValue> = {
            [RecordSharingFixture.OwningBu]: owningBu, [RecordSharingFixture.Label]: label, [RecordSharingFixture.Secret]: RecordSharingFixture.SecretValue,
        }
        const result = await (await this.Store()).Apply({
            Source: BuiltinBindings.CollectionFor(RecordSharingFixture.Qualified), IdKey: RecordSharingFixture.IdField,
            Operations: [{ Kind: WriteOperationKind.Upsert, Key: key, Fields: fields }],
        })
        assert.equal(result.Applied, 1)
    }

    private async Store(): Promise<IDataSourceAdapter>
    {
        if (this.store === undefined)
        {
            const factory = new BuiltinAdapterFactory((root, engine) => new NodePlatform().CreateAppDataStore(root, engine))
            this.store = await factory.Open({
                Kind: DataSourceKind.Builtin,
                Config: {
                    [BuiltinAdapterFactory.DataRootKey]: join(this.apps, RecordSharingFixture.AppName, RecordSharingFixture.DataDir),
                    [BuiltinAdapterFactory.EngineKey]: BuiltinStoreEngine.Document,
                },
            })
        }
        return this.store
    }

    public async ShareWithPrincipal(server: PragmaticServer, principalId: string): Promise<void>
    {
        await server.AppShareStore(RecordSharingFixture.AppName).Grant({
            concept: RecordSharingFixture.Qualified, recordId: RecordSharingFixture.SharedRecordId,
            subject: { kind: ShareSubjectKind.Principal, id: principalId }, rights: [PrivilegeAction.Read],
        })
    }

    public async Dispose(): Promise<void>
    {
        await this.store?.Dispose()
        await this.server?.Dispose()
        rmSync(this.packages, { recursive: true, force: true })
        rmSync(this.apps, { recursive: true, force: true })
        rmSync(this.identityRoot, { recursive: true, force: true })
        PpSecurityHarness.ClearKey()
    }

    /** label -> secret (null when masked), sorted by label. */
    public static Rows(graph: IGraphQuery): Array<[string, string | null]>
    {
        return Cypher.CypherEngine.OverQuery(graph).Execute(RecordSharingFixture.Query).Rows
            .map(r => [
                r[0] instanceof Cypher.ScalarValue ? String(r[0].Value) : '',
                r[1] instanceof Cypher.ScalarValue && r[1].Value !== null ? String(r[1].Value) : null,
            ] as [string, string | null])
            .sort((a, b) => a[0].localeCompare(b[0]))
    }

    /** BusinessUnit-level Read for both principals (sales); `secret` is secured and no profile is assigned to anyone. */
    private static Model(): ISecurityModelConfig
    {
        const base = PpSecurityHarness.BuSecurityModel(RecordSharingFixture.Principal)
        const reader = base.roles[0].id
        const target = (concept: string) => concept === PpSecurityHarness.Concept ? RecordSharingFixture.Qualified : concept
        return {
            ...base,
            ownershipRules: base.ownershipRules.map(r => ({ ...r, concept: target(r.concept) })),
            roles: base.roles.map(r => ({ ...r, privileges: r.privileges.map(p => ({ ...p, concept: target(p.concept) })) })),
            membership: { claimsMapping: [], overrides: [
                { principalId: RecordSharingFixture.Principal, homeBusinessUnit: PpSecurityHarness.SalesBu, teams: [] },
                { principalId: RecordSharingFixture.Other, homeBusinessUnit: PpSecurityHarness.SalesBu, teams: [] },
            ] },
            roleAssignment: { claimsMapping: [], teamRoles: [], overrides: [
                { principalId: RecordSharingFixture.Principal, roles: [reader] },
                { principalId: RecordSharingFixture.Other, roles: [reader] },
            ] },
            fieldSecurity: {
                securedFields: [{ concept: RecordSharingFixture.Qualified, field: RecordSharingFixture.Secret }],
                profiles: [{ id: RecordSharingFixture.Profile, name: RecordSharingFixture.ProfileName, grants: [{ concept: RecordSharingFixture.Qualified, field: RecordSharingFixture.Secret, read: true }] }],
                profileAssignment: { claimsMapping: [], teamProfiles: [], overrides: [] },
            },
        }
    }

    private static Repo(): Repository
    {
        const repo = new Repository()
        repo.builder()
            .setNamespace('shop')
            .defineConcept(RecordSharingFixture.Qualified)
            .addField(RecordSharingFixture.Qualified, RecordSharingFixture.IdField, 'string', Cardinality.Optional)
            .addField(RecordSharingFixture.Qualified, RecordSharingFixture.OwningBu, 'string', Cardinality.Optional)
            .addField(RecordSharingFixture.Qualified, RecordSharingFixture.Label, 'string', Cardinality.Optional)
            .addField(RecordSharingFixture.Qualified, RecordSharingFixture.Secret, 'string', Cardinality.Optional)
            .commit()
        return repo
    }
}

test('without a share, the root-owned and predicate-denied records are hidden', async () =>
{
    const fx = new RecordSharingFixture()
    try
    {
        const server = await fx.Setup()
        const graph = await server.GraphForPragmaticApp(PpSecurityHarness.Context(RecordSharingFixture.Principal), RecordSharingFixture.Name, Cypher.ReferencedLabels.Of(RecordSharingFixture.Query))
        assert.deepEqual(RecordSharingFixture.Rows(graph), [[RecordSharingFixture.VisibleLabel, null]])
    }
    finally
    {
        await fx.Dispose()
    }
})

test('a Read share bypasses depth AND the attribute predicate for that record only; the unshared record stays hidden; field mask stays', async () =>
{
    const fx = new RecordSharingFixture()
    try
    {
        const server = await fx.Setup()
        await fx.ShareWithPrincipal(server, RecordSharingFixture.Principal)
        const graph = await server.GraphForPragmaticApp(PpSecurityHarness.Context(RecordSharingFixture.Principal), RecordSharingFixture.Name, Cypher.ReferencedLabels.Of(RecordSharingFixture.Query))
        assert.deepEqual(RecordSharingFixture.Rows(graph), [
            [RecordSharingFixture.VisibleLabel, null],
            [RecordSharingFixture.SharedLabel, null],
        ])
    }
    finally
    {
        await fx.Dispose()
    }
})

test('a share to another principal does not widen this principal', async () =>
{
    const fx = new RecordSharingFixture()
    try
    {
        const server = await fx.Setup()
        await fx.ShareWithPrincipal(server, RecordSharingFixture.Other)
        const graph = await server.GraphForPragmaticApp(PpSecurityHarness.Context(RecordSharingFixture.Principal), RecordSharingFixture.Name, Cypher.ReferencedLabels.Of(RecordSharingFixture.Query))
        assert.deepEqual(RecordSharingFixture.Rows(graph), [[RecordSharingFixture.VisibleLabel, null]])
        const other = await server.GraphForPragmaticApp(PpSecurityHarness.Context(RecordSharingFixture.Other), RecordSharingFixture.Name, Cypher.ReferencedLabels.Of(RecordSharingFixture.Query))
        assert.deepEqual(RecordSharingFixture.Rows(other), [[RecordSharingFixture.VisibleLabel, null], [RecordSharingFixture.SharedLabel, null]])
    }
    finally
    {
        await fx.Dispose()
    }
})

test('share ops: a Read-only actor is Denied sharing a visible record; List sees grants only for visible records; a hidden record is NotFound', async () =>
{
    const fx = new RecordSharingFixture()
    try
    {
        const server = await fx.Setup()
        const context = PpSecurityHarness.Context(RecordSharingFixture.Principal)
        const subject = { kind: ShareSubjectKind.Principal, id: RecordSharingFixture.Other }
        const concept = 'shop.Widget'
        const denied = await server.ShareForPragmaticApp(context, RecordSharingFixture.Name, { concept, id: 'rec-visible', subject, rights: [PrivilegeAction.Read] })
        assert.equal(denied.status, ShareStatus.Denied)
        const hidden = await server.ShareForPragmaticApp(context, RecordSharingFixture.Name, { concept, id: 'rec-hidden', subject, rights: [PrivilegeAction.Read] })
        assert.equal(hidden.status, ShareStatus.NotFound)
        await fx.ShareWithPrincipal(server, RecordSharingFixture.Principal)
        const listed = await server.ListSharesForPragmaticApp(context, RecordSharingFixture.Name, { concept, id: RecordSharingFixture.SharedRecordId })
        assert.equal(listed.grants.length, 1)
        const none = await server.ListSharesForPragmaticApp(context, RecordSharingFixture.Name, { concept, id: 'rec-hidden' })
        assert.equal(none.grants.length, 0)
    }
    finally
    {
        await fx.Dispose()
    }
})
