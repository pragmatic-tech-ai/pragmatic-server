import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import {
    Repository, Cardinality, toJSON, BlobPackageStore, StoragePackageSink, Cypher,
    type PackageDocument, type CompiledPackage,
} from '@pragmatic-tech-ai/todl'
import type { IGraphQuery } from '@pragmatic-tech-ai/todl/graph-api'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../../pragmatic-server.js'
import { TenantPurpose } from '../../../tenancy/tenant-purpose.js'
import { PpSecurityHarness } from './pp-security-harness.js'

class FieldSecurityFixture
{
    private static readonly Id = 'shop'
    private static readonly Version = '1.0.0'
    private static readonly PkgPrefix = 'fsec-pkgs-'
    private static readonly AppsPrefix = 'fsec-apps-'
    private static readonly IdPrefix = 'fsec-id-'
    private static readonly AppName = 'demo'
    private static readonly ManifestFile = 'application.json'
    private static readonly SourceSuffix = '.todl'
    private static readonly Label = 'label'
    private static readonly Secret = 'secret'
    private static readonly SecretValue = 'hush'
    private static readonly ReturnQuery = 'MATCH (w:Widget) RETURN w.label AS label, w.secret AS secret'
    private static readonly WhereQuery = "MATCH (w:Widget) WHERE w.secret = 'hush' RETURN w.label AS label"
    private static readonly Profile = 'cost-readers'
    private static readonly ProfileName = 'Cost readers'
    public static readonly Plain = 'p1'
    public static readonly Granted = 'p2'

    private readonly packages = mkdtempSync(join(tmpdir(), FieldSecurityFixture.PkgPrefix))
    private readonly apps = mkdtempSync(join(tmpdir(), FieldSecurityFixture.AppsPrefix))
    private readonly identityRoot = mkdtempSync(join(tmpdir(), FieldSecurityFixture.IdPrefix))
    private server: PragmaticServer | undefined

    public static get Name(): string
    {
        return FieldSecurityFixture.AppName
    }

    public static get Hidden(): string
    {
        return FieldSecurityFixture.SecretValue
    }

    public async Setup(): Promise<PragmaticServer>
    {
        PpSecurityHarness.SetKey()
        const doc = toJSON(FieldSecurityFixture.Repo()) as PackageDocument
        const pkg: CompiledPackage = {
            id: FieldSecurityFixture.Id, version: FieldSecurityFixture.Version, document: doc, fullDocument: doc,
            sources: [{ uri: FieldSecurityFixture.Id + FieldSecurityFixture.SourceSuffix, text: '' }], classes: [],
        }
        await new BlobPackageStore(new StoragePackageSink(new NodeFsStorage(this.packages))).persist(pkg)
        mkdirSync(join(this.apps, FieldSecurityFixture.AppName))
        writeFileSync(join(this.apps, FieldSecurityFixture.AppName, FieldSecurityFixture.ManifestFile), JSON.stringify({
            name: FieldSecurityFixture.AppName, version: FieldSecurityFixture.Version,
            packages: [{ id: FieldSecurityFixture.Id, version: FieldSecurityFixture.Version }],
        }))
        this.server = new PragmaticServer({
            packagesRoot: this.packages, applicationsRoot: this.apps, purpose: TenantPurpose.Runtime,
            identity: PpSecurityHarness.Identity(this.identityRoot),
        })
        await this.server.Start()
        await PpSecurityHarness.Seed(this.server, FieldSecurityFixture.Model())
        return this.server
    }

    public async Dispose(): Promise<void>
    {
        await this.server?.Dispose()
        rmSync(this.packages, { recursive: true, force: true })
        rmSync(this.apps, { recursive: true, force: true })
        rmSync(this.identityRoot, { recursive: true, force: true })
        PpSecurityHarness.ClearKey()
    }

    public static Rows(graph: IGraphQuery): Array<[string, string | null]>
    {
        return Cypher.CypherEngine.OverQuery(graph).Execute(FieldSecurityFixture.ReturnQuery).Rows
            .map(r => [FieldSecurityFixture.Text(r[0]), r[1] instanceof Cypher.ScalarValue && r[1].Value !== null ? String(r[1].Value) : null] as [string, string | null])
    }

    public static Matches(graph: IGraphQuery): string[]
    {
        return Cypher.CypherEngine.OverQuery(graph).Execute(FieldSecurityFixture.WhereQuery).Rows
            .map(r => FieldSecurityFixture.Text(r[0]))
    }

    private static Text(value: unknown): string
    {
        return value instanceof Cypher.ScalarValue ? String(value.Value) : ''
    }

    /** Org-level Read for both principals; `secret` is secured and only the Granted principal holds a profile reading it. */
    private static Model(): ISecurityModelConfig
    {
        const base = PpSecurityHarness.OrgSecurityModel(FieldSecurityFixture.Plain)
        const reader = base.roles[0].id
        return {
            ...base,
            membership: { claimsMapping: [], overrides: [
                { principalId: FieldSecurityFixture.Plain, homeBusinessUnit: PpSecurityHarness.SalesBu, teams: [] },
                { principalId: FieldSecurityFixture.Granted, homeBusinessUnit: PpSecurityHarness.SalesBu, teams: [] },
            ] },
            roleAssignment: { claimsMapping: [], teamRoles: [], overrides: [
                { principalId: FieldSecurityFixture.Plain, roles: [reader] },
                { principalId: FieldSecurityFixture.Granted, roles: [reader] },
            ] },
            fieldSecurity: {
                securedFields: [{ concept: PpSecurityHarness.Concept, field: FieldSecurityFixture.Secret }],
                profiles: [{ id: FieldSecurityFixture.Profile, name: FieldSecurityFixture.ProfileName, grants: [{ concept: PpSecurityHarness.Concept, field: FieldSecurityFixture.Secret, read: true }] }],
                profileAssignment: { claimsMapping: [], teamProfiles: [], overrides: [{ principalId: FieldSecurityFixture.Granted, profiles: [FieldSecurityFixture.Profile] }] },
            },
        }
    }

    private static Repo(): Repository
    {
        const repo = new Repository()
        repo.builder()
            .defineConcept(PpSecurityHarness.Concept)
            .addField(PpSecurityHarness.Concept, PpSecurityHarness.OwningBuField, 'string', Cardinality.Optional)
            .addField(PpSecurityHarness.Concept, FieldSecurityFixture.Label, 'string', Cardinality.Optional)
            .addField(PpSecurityHarness.Concept, FieldSecurityFixture.Secret, 'string', Cardinality.Optional)
            .setNamespace('shop')
            .assertInstance(PpSecurityHarness.Concept, 'shop.w1')
            .setField('shop.w1', PpSecurityHarness.OwningBuField, PpSecurityHarness.SalesBu)
            .setField('shop.w1', FieldSecurityFixture.Label, 'W1')
            .setField('shop.w1', FieldSecurityFixture.Secret, FieldSecurityFixture.SecretValue)
            .commit()
        return repo
    }
}

test('a principal without a granting profile sees the secured field as null and cannot filter on it', async () =>
{
    const fx = new FieldSecurityFixture()
    try
    {
        const server = await fx.Setup()
        const graph = await server.GraphForPragmaticApp(PpSecurityHarness.Context(FieldSecurityFixture.Plain), FieldSecurityFixture.Name)
        assert.deepEqual(FieldSecurityFixture.Rows(graph), [['W1', null]])
        assert.deepEqual(FieldSecurityFixture.Matches(graph), [])
    }
    finally
    {
        await fx.Dispose()
    }
})

test('a principal with a granting profile reads and filters on the secured field', async () =>
{
    const fx = new FieldSecurityFixture()
    try
    {
        const server = await fx.Setup()
        const graph = await server.GraphForPragmaticApp(PpSecurityHarness.Context(FieldSecurityFixture.Granted), FieldSecurityFixture.Name)
        assert.deepEqual(FieldSecurityFixture.Rows(graph), [['W1', FieldSecurityFixture.Hidden]])
        assert.deepEqual(FieldSecurityFixture.Matches(graph), ['W1'])
    }
    finally
    {
        await fx.Dispose()
    }
})

test('the unmasked internal fetch still sees the secured field (write-gate path)', async () =>
{
    const fx = new FieldSecurityFixture()
    try
    {
        const server = await fx.Setup()
        const graph = await server.GraphForPragmaticApp(PpSecurityHarness.Context(FieldSecurityFixture.Plain), FieldSecurityFixture.Name, undefined, false)
        assert.deepEqual(FieldSecurityFixture.Rows(graph), [['W1', FieldSecurityFixture.Hidden]])
    }
    finally
    {
        await fx.Dispose()
    }
})
