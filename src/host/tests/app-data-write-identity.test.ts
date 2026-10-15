import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compilePackage, BlobPackageStore, StoragePackageSink, Cypher } from '@pragmatic-tech-ai/todl'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { AccessContext, Principal, PrincipalKind, Tenant, TenantKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy, IdentityConfig, PrivilegeAction, AccessLevel, OwnershipSourceKind } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { AppWriteOpKind, AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AppWriteOpDto, AppWriteResultDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { PragmaticServer } from '../../pragmatic-server.js'
import { TenantPurpose } from '../../tenancy/tenant-purpose.js'
import { BuiltinStoreEngine } from '../connectors/builtin-store-engine.js'

class IdFixture
{
    private static readonly KeyEnv = 'PS_SP3D_KEY'
    private static readonly Id = 'shop'
    private static readonly Version = '1.0.0'
    public static readonly AppName = 'demo'
    public static readonly TenantId = 't1'
    public static readonly Widget = 'shop.Widget'
    private static readonly ManifestFile = 'application.json'
    private static readonly Labels = 'MATCH (w:Widget) RETURN w.owningBu AS bu'
    private static readonly Todl = `
namespace shop {
  concept Widget { label : string; owningBu : string; }
  model Shop : shop {
    annotate entrypoint { }
    Widget w0 { label = "seed"; owningBu = "root"; }
  }
}
`
    private readonly packages = mkdtempSync(join(tmpdir(), 'sp3d-pkgs-'))
    private readonly apps = mkdtempSync(join(tmpdir(), 'sp3d-apps-'))
    private readonly identityRoot = mkdtempSync(join(tmpdir(), 'sp3d-id-'))
    private server: PragmaticServer | undefined

    public async Setup(): Promise<void>
    {
        process.env[IdFixture.KeyEnv] = randomBytes(32).toString('base64')
        const outcome = compilePackage([], [{ uri: 'shop.todl', text: IdFixture.Todl }], { id: IdFixture.Id, version: IdFixture.Version })
        assert.ok(outcome.ok, JSON.stringify(outcome.errors))
        await new BlobPackageStore(new StoragePackageSink(new NodeFsStorage(this.packages))).persist(outcome.package!)
        mkdirSync(join(this.apps, IdFixture.AppName))
        writeFileSync(join(this.apps, IdFixture.AppName, IdFixture.ManifestFile), JSON.stringify({ name: IdFixture.AppName, version: IdFixture.Version, packages: [{ id: IdFixture.Id, version: IdFixture.Version }] }))
        this.server = new PragmaticServer({
            packagesRoot: this.packages, applicationsRoot: this.apps, purpose: TenantPurpose.Runtime,
            builtinStoreEngine: BuiltinStoreEngine.Document,
            identity: { identityRoot: this.identityRoot, masterKey: { base64Env: IdFixture.KeyEnv }, tenant: { id: IdFixture.TenantId, displayName: 'Tenant One' } },
        })
        await this.server.Start()
        await this.Seed()
    }

    private async Seed(): Promise<void>
    {
        const store = await this.server!.TenantConfigStore()
        const seeded = await store.Get(IdFixture.TenantId)
        assert.ok(seeded !== null, 'tenant config was not seeded on boot')
        const merged = new IdentityConfig(seeded!.PackId, seeded!.DelegationDepth, seeded!.ProviderSettings, seeded!.GroupRoleMap, seeded!.ClaimsMapping, IdFixture.Model())
        await store.Save(IdFixture.TenantId, merged)
    }

    private static Model(): ISecurityModelConfig
    {
        return {
            businessUnits: [{ id: 'root', name: 'Root' }, { id: 'sales', name: 'Sales', parent: 'root' }],
            teams: [],
            membership: { claimsMapping: [], overrides: [{ principalId: 'u1', homeBusinessUnit: 'sales', teams: [] }] },
            ownershipRules: [{ concept: IdFixture.Widget, owningBusinessUnit: { kind: OwnershipSourceKind.FromField, value: 'owningBu' } }],
            roles: [{
                id: 'rw', name: 'RW', privileges: [
                    { action: PrivilegeAction.Read, concept: IdFixture.Widget, level: AccessLevel.Organization },
                    { action: PrivilegeAction.Create, concept: IdFixture.Widget, level: AccessLevel.BusinessUnit },
                    { action: PrivilegeAction.Update, concept: IdFixture.Widget, level: AccessLevel.BusinessUnit },
                    { action: PrivilegeAction.Delete, concept: IdFixture.Widget, level: AccessLevel.BusinessUnit },
                ],
            }],
            roleAssignment: { claimsMapping: [], overrides: [{ principalId: 'u1', roles: ['rw'] }], teamRoles: [] },
        } as ISecurityModelConfig
    }

    private static Context(): AccessContext
    {
        const tenant = new Tenant(IdFixture.TenantId, TenantKind.SelfHosted, 'Tenant One')
        const principal = new Principal('u1', IdFixture.TenantId, PrincipalKind.User, new Map(), [])
        const grants = [new Grant('u1', Role.Owner, new ResourceRef(ResourceKind.Tenant, IdFixture.TenantId, []))]
        return new AccessContext(principal, tenant, grants, new ResourceAuthorizationPolicy())
    }

    public Write(ops: AppWriteOpDto[]): Promise<AppWriteResultDto>
    {
        return this.server!.WriteForPragmaticApp(IdFixture.Context(), IdFixture.AppName, ops)
    }

    public async Bus(): Promise<string[]>
    {
        const graph = await this.server!.GraphForPragmaticApp(IdFixture.Context(), IdFixture.AppName, Cypher.ReferencedLabels.Of(IdFixture.Labels))
        return Cypher.CypherEngine.OverQuery(graph).Execute(IdFixture.Labels).Rows
            .map(r => (r[0] instanceof Cypher.ScalarValue ? String(r[0].Value) : '')).sort()
    }

    public async Dispose(): Promise<void>
    {
        await this.server?.Dispose()
        delete process.env[IdFixture.KeyEnv]
        rmSync(this.packages, { recursive: true, force: true })
        rmSync(this.apps, { recursive: true, force: true })
        rmSync(this.identityRoot, { recursive: true, force: true })
    }
}

class Case
{
    public static async Run(body: (fx: IdFixture) => Promise<void>): Promise<void>
    {
        const fx = new IdFixture()
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

test('create stamps the creator home BU and the stamped row is updatable', async () =>
{
    await Case.Run(async fx =>
    {
        const created = await fx.Write([{ op: AppWriteOpKind.Create, concept: IdFixture.Widget, fields: { label: 'mine' } }])
        assert.equal(created.results[0].status, AppWriteStatus.Applied)
        const id = created.results[0].id as string
        assert.deepEqual(await fx.Bus(), ['root', 'sales'])
        const updated = await fx.Write([{ op: AppWriteOpKind.Update, concept: IdFixture.Widget, id, fields: { label: 'mine2' } }])
        assert.equal(updated.results[0].status, AppWriteStatus.Applied)
    })
})

test('update of an out-of-BU row is denied though it is readable', async () =>
{
    await Case.Run(async fx =>
    {
        // Seed row w0 has owningBu = "root"; principal u1 writes at BU "sales" (root is out of reach), reads at Org.
        assert.deepEqual(await fx.Bus(), ['root'])
        const out = await fx.Write([{ op: AppWriteOpKind.Update, concept: IdFixture.Widget, id: 'w0', fields: { label: 'hijack' } }])
        assert.equal(out.results[0].status, AppWriteStatus.Denied)
        assert.equal(out.results[0].reason, 'not authorized for this record')
    })
})

test('a create targeting an existing out-of-scope row id cannot overwrite it', async () =>
{
    await Case.Run(async fx =>
    {
        // Seed row w0 is owned by "root" (out of u1's write reach). A create with the same id and an in-scope owningBu must not overwrite it.
        const out = await fx.Write([{ op: AppWriteOpKind.Create, concept: IdFixture.Widget, id: 'w0', fields: { label: 'hijacked', owningBu: 'sales' } }])
        assert.equal(out.results[0].status, AppWriteStatus.Denied)
        assert.equal(out.results[0].reason, 'not authorized for this record')
        // w0 is untouched: still owned by root, never flipped to sales.
        const bus = await fx.Bus()
        assert.ok(bus.includes('root'))
        assert.ok(!bus.includes('sales'))
    })
})
