import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import {
    Repository, Cardinality, toJSON, BlobPackageStore, StoragePackageSink,
    type PackageDocument, type CompiledPackage, PackageSecurity,
} from '@pragmatic-tech-ai/todl'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../../pragmatic-server.js'
import { TenantPurpose } from '../../../tenancy/tenant-purpose.js'
import { PpSecurityHarness } from './pp-security-harness.js'
import { AllowAllFieldReadMaskSource, TenantReadAuthorization } from '../read-filter-source.js'

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
    private static readonly Namespace = 'shop'
    private static readonly Qualified = 'shop.Widget'
    private static readonly Label = 'label'
    private static readonly Secret = 'secret'
    private static readonly SecretValue = 'hush'
    private static readonly Profile = 'cost-readers'
    private static readonly ProfileName = 'Cost readers'
    public static readonly Plain = 'p1'
    public static readonly Granted = 'p2'

    private readonly packages = mkdtempSync(join(tmpdir(), FieldSecurityFixture.PkgPrefix))
    private readonly apps = mkdtempSync(join(tmpdir(), FieldSecurityFixture.AppsPrefix))
    private readonly identityRoot = mkdtempSync(join(tmpdir(), FieldSecurityFixture.IdPrefix))
    private server: PragmaticServer | undefined

    public async Setup(identityOn = true): Promise<PragmaticServer>
    {
        PpSecurityHarness.SetKey()
        const doc = toJSON(FieldSecurityFixture.Repo()) as PackageDocument
        const pkg: CompiledPackage = {
            id: FieldSecurityFixture.Id, version: FieldSecurityFixture.Version, document: doc, fullDocument: doc,
            sources: [{ uri: FieldSecurityFixture.Id + FieldSecurityFixture.SourceSuffix, text: '' }], classes: [], Security: PackageSecurity.Empty,
        }
        await new BlobPackageStore(new StoragePackageSink(new NodeFsStorage(this.packages))).persist(pkg)
        mkdirSync(join(this.apps, FieldSecurityFixture.AppName))
        writeFileSync(join(this.apps, FieldSecurityFixture.AppName, FieldSecurityFixture.ManifestFile), JSON.stringify({
            name: FieldSecurityFixture.AppName, version: FieldSecurityFixture.Version,
            packages: [{ id: FieldSecurityFixture.Id, version: FieldSecurityFixture.Version }],
        }))
        this.server = new PragmaticServer({
            packagesRoot: this.packages, applicationsRoot: this.apps, purpose: TenantPurpose.Runtime,
            identity: identityOn ? PpSecurityHarness.Identity(this.identityRoot) : undefined,
        })
        await this.server.Start()
        if (identityOn)
        {
            await PpSecurityHarness.Seed(this.server, FieldSecurityFixture.Model())
        }
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

    /** Org-level Read for both principals; `secret` is secured and only the Granted principal holds a profile reading it. */
    private static Model(): ISecurityModelConfig
    {
        const base = PpSecurityHarness.OrgSecurityModel(FieldSecurityFixture.Plain)
        const reader = base.roles[0].id
        return {
            ...base,
            ownershipRules: base.ownershipRules.map(r => ({ ...r, concept: FieldSecurityFixture.Qualified })),
            roles: base.roles.map(r => ({ ...r, privileges: r.privileges.map(p => ({ ...p, concept: FieldSecurityFixture.Qualified })) })),
            membership: { claimsMapping: [], overrides: [
                { principalId: FieldSecurityFixture.Plain, homeBusinessUnit: PpSecurityHarness.SalesBu, teams: [] },
                { principalId: FieldSecurityFixture.Granted, homeBusinessUnit: PpSecurityHarness.SalesBu, teams: [] },
            ] },
            roleAssignment: { claimsMapping: [], teamRoles: [], overrides: [
                { principalId: FieldSecurityFixture.Plain, roles: [reader] },
                { principalId: FieldSecurityFixture.Granted, roles: [reader] },
            ] },
            fieldSecurity: {
                securedFields: [{ concept: FieldSecurityFixture.Qualified, field: FieldSecurityFixture.Secret }],
                profiles: [{ id: FieldSecurityFixture.Profile, name: FieldSecurityFixture.ProfileName, grants: [{ concept: FieldSecurityFixture.Qualified, field: FieldSecurityFixture.Secret, read: true }] }],
                profileAssignment: { claimsMapping: [], teamProfiles: [], overrides: [{ principalId: FieldSecurityFixture.Granted, profiles: [FieldSecurityFixture.Profile] }] },
            },
        }
    }

    private static Repo(): Repository
    {
        const repo = new Repository()
        repo.builder()
            .setNamespace(FieldSecurityFixture.Namespace)
            .defineConcept(FieldSecurityFixture.Qualified)
            .addField(FieldSecurityFixture.Qualified, PpSecurityHarness.OwningBuField, 'string', Cardinality.Optional)
            .addField(FieldSecurityFixture.Qualified, FieldSecurityFixture.Label, 'string', Cardinality.Optional)
            .addField(FieldSecurityFixture.Qualified, FieldSecurityFixture.Secret, 'string', Cardinality.Optional)
            .assertInstance(FieldSecurityFixture.Qualified, 'shop.w1')
            .setField('shop.w1', PpSecurityHarness.OwningBuField, PpSecurityHarness.SalesBu)
            .setField('shop.w1', FieldSecurityFixture.Label, 'W1')
            .setField('shop.w1', FieldSecurityFixture.Secret, FieldSecurityFixture.SecretValue)
            .commit()
        return repo
    }
}

test('FieldReadMaskSource is allow-all with identity off', async () =>
{
    const fx = new FieldSecurityFixture()
    try
    {
        const server = await fx.Setup(false)
        assert.equal(await server.FieldReadMaskSource(), AllowAllFieldReadMaskSource.Instance)
    }
    finally
    {
        await fx.Dispose()
    }
})

test('FieldReadMaskSource is the tenant read authorization with identity on', async () =>
{
    const fx = new FieldSecurityFixture()
    try
    {
        const server = await fx.Setup()
        const source = await server.FieldReadMaskSource()
        assert.ok(source instanceof TenantReadAuthorization)
        assert.notEqual(source, AllowAllFieldReadMaskSource.Instance)
    }
    finally
    {
        await fx.Dispose()
    }
})
