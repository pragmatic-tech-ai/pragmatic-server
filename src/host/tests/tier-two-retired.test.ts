import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppWriteOpKind, AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { compilePackage, BlobPackageStore, StoragePackageSink } from '@pragmatic-tech-ai/todl'
import { AccessLevel, PrivilegeAction, OwnershipSourceKind } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { PragmaticServer } from '../../pragmatic-server.js'
import { TenantPurpose } from '../../tenancy/tenant-purpose.js'
import { PpSecurityHarness } from '../cypher/tests/pp-security-harness.js'

/*
 * Tier 2 (per-app access policy files, TODL model policies, app-private concept governance) is retired: only the
 * tenant security model (tier 1) decides runtime and dev visibility.
 */

/**
 * A runtime tenant with identity: app `crm` binds packages crm (crm.Account, governed) and notes (notes.Note, NOT
 * governed). Its data/write runs on the environment engine under the caller's scope (ruling S10); runtime reads are the
 * environment engine's (environment-scope-rules.test.ts pins that a retired access-policy.json changes nothing).
 */
class RuntimeTierFixture
{
    public static readonly Reader = 'p1'
    public static readonly Note = 'notes.Note'
    private static readonly AppName = 'crm'
    private static readonly Version = '1.0.0'
    private static readonly Account = 'crm.Account'
    private static readonly CrmPkg = 'crm'
    private static readonly NotesPkg = 'notes'
    private static readonly ManifestFile = 'application.json'
    private static readonly LivePointerFile = 'live'
    private static readonly ReaderRole = 'reader'
    private static readonly ReaderRoleName = 'Reader'
    private static readonly RootName = 'Root'
    private static readonly SalesName = 'Sales'
    private static readonly NoteLabel = 'draft'
    private static readonly PackagesPrefix = 'tier2-pkgs-'
    private static readonly AppsPrefix = 'tier2-apps-'
    private static readonly IdentityPrefix = 'tier2-id-'
    private static readonly GraphsPrefix = 'tier2-graphs-'
    private static readonly CrmTodl = 'namespace crm { concept Account { owningBu : string; } model Crm : crm { annotate entrypoint { } Account a1 { label = "acme"; owningBu = "sales"; } } }'
    private static readonly NotesTodl = 'namespace notes { concept Note { } model Notes : notes { annotate entrypoint { } Note n1 { label = "hello"; } } }'

    private readonly packages = mkdtempSync(join(tmpdir(), RuntimeTierFixture.PackagesPrefix))
    private readonly apps = mkdtempSync(join(tmpdir(), RuntimeTierFixture.AppsPrefix))
    private readonly identityRoot = mkdtempSync(join(tmpdir(), RuntimeTierFixture.IdentityPrefix))
    private readonly graphs = mkdtempSync(join(tmpdir(), RuntimeTierFixture.GraphsPrefix))
    private server: PragmaticServer | undefined

    public static async Run(body: (fx: RuntimeTierFixture) => Promise<void>): Promise<void>
    {
        const fx = new RuntimeTierFixture()
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

    public CreateNote(principal: string): ReturnType<PragmaticServer['WriteForPragmaticApp']>
    {
        return this.server!.WriteForPragmaticApp(PpSecurityHarness.Context(principal), RuntimeTierFixture.AppName,
            [{ op: AppWriteOpKind.Create, concept: RuntimeTierFixture.Note, fields: { label: RuntimeTierFixture.NoteLabel } }])
    }

    private async Setup(): Promise<void>
    {
        PpSecurityHarness.SetKey()
        await this.Publish(RuntimeTierFixture.CrmPkg, RuntimeTierFixture.CrmTodl)
        await this.Publish(RuntimeTierFixture.NotesPkg, RuntimeTierFixture.NotesTodl)
        // a live app (`<app>/<version>/application.json` + `<app>/live`): its packages are environment deliveries
        mkdirSync(join(this.apps, RuntimeTierFixture.AppName, RuntimeTierFixture.Version), { recursive: true })
        writeFileSync(join(this.apps, RuntimeTierFixture.AppName, RuntimeTierFixture.Version, RuntimeTierFixture.ManifestFile), JSON.stringify({
            name: RuntimeTierFixture.AppName, version: RuntimeTierFixture.Version,
            packages: [{ id: RuntimeTierFixture.CrmPkg, version: RuntimeTierFixture.Version }, { id: RuntimeTierFixture.NotesPkg, version: RuntimeTierFixture.Version }],
        }))
        writeFileSync(join(this.apps, RuntimeTierFixture.AppName, RuntimeTierFixture.LivePointerFile), RuntimeTierFixture.Version)
        this.server = new PragmaticServer({
            packagesRoot: this.packages, applicationsRoot: this.apps, graphsRoot: this.graphs, purpose: TenantPurpose.Runtime,
            identity: PpSecurityHarness.Identity(this.identityRoot),
        })
        await this.server.Start()
        await PpSecurityHarness.Seed(this.server, RuntimeTierFixture.Model())
    }

    private async Publish(id: string, text: string): Promise<void>
    {
        const outcome = compilePackage([], [{ uri: `${id}.todl`, text }], { id, version: RuntimeTierFixture.Version })
        assert.ok(outcome.ok, JSON.stringify(outcome.errors))
        await new BlobPackageStore(new StoragePackageSink(new NodeFsStorage(this.packages))).persist(outcome.package!)
    }

    /** Governs only crm.Account: the reader holds an organisation-level read (and create) on it; notes.Note is never named. */
    private static Model(): ISecurityModelConfig
    {
        return {
            businessUnits: [{ id: PpSecurityHarness.RootBu, name: RuntimeTierFixture.RootName }, { id: PpSecurityHarness.SalesBu, name: RuntimeTierFixture.SalesName, parent: PpSecurityHarness.RootBu }],
            teams: [],
            membership: { claimsMapping: [], overrides: [{ principalId: RuntimeTierFixture.Reader, homeBusinessUnit: PpSecurityHarness.SalesBu, teams: [] }] },
            ownershipRules: [{ concept: RuntimeTierFixture.Account, owningBusinessUnit: { kind: OwnershipSourceKind.FromField, value: PpSecurityHarness.OwningBuField } }],
            roles: [{ id: RuntimeTierFixture.ReaderRole, name: RuntimeTierFixture.ReaderRoleName, privileges: [
                { action: PrivilegeAction.Read, concept: RuntimeTierFixture.Account, level: AccessLevel.Organization },
                { action: PrivilegeAction.Create, concept: RuntimeTierFixture.Account, level: AccessLevel.Organization },
            ] }],
            roleAssignment: { claimsMapping: [], overrides: [{ principalId: RuntimeTierFixture.Reader, roles: [RuntimeTierFixture.ReaderRole] }], teamRoles: [] },
        }
    }

    private async Dispose(): Promise<void>
    {
        await this.server?.Dispose()
        rmSync(this.packages, { recursive: true, force: true })
        rmSync(this.apps, { recursive: true, force: true })
        rmSync(this.identityRoot, { recursive: true, force: true })
        rmSync(this.graphs, { recursive: true, force: true })
        PpSecurityHarness.ClearKey()
    }
}

test('own concept the security model does not govern is denied', async () =>
{
    await RuntimeTierFixture.Run(async fx =>
    {
        const created = await fx.CreateNote(RuntimeTierFixture.Reader)
        assert.equal(created.results[0]?.status, AppWriteStatus.Denied)
    })
})
