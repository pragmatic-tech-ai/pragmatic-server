import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { TemplateCatalog, InvalidEnvironmentNameError } from '../template-catalog.js'
import { Template, EnvType } from '../environment-record.js'
import { EnvKind, TenantPurposeName } from '../../../environments/seed/bundle.js'

class CatalogFixture
{
    public static readonly SecurityModel = 'security-model.json'
    public static readonly Backslash = String.fromCharCode(92)
    public static readonly DemoSuffix = 'environments/demo/seed'

    public static Norm(p: string): string
    {
        return p.split(CatalogFixture.Backslash).join('/')
    }
}

describe('TemplateCatalog', () =>
{
    it('resolves demo-contoso', () =>
    {
        const r = TemplateCatalog.Resolve(Template.DemoContoso, 'demo1', 8081, EnvType.Runtime)
        assert.equal(r.def.kind, EnvKind.Demo)
        assert.equal(r.def.tenantId, 'contoso')
        assert.equal(r.def.purpose, TenantPurposeName.Runtime)
        assert.equal(r.def.name, 'demo1')
        assert.equal(r.def.hostPort, 8081)
        assert.ok(CatalogFixture.Norm(r.seedDir).endsWith(CatalogFixture.DemoSuffix))
        assert.ok(existsSync(r.seedDir))
        assert.ok(existsSync(join(r.seedDir, CatalogFixture.SecurityModel)))
    })

    it('resolves dev-blank', () =>
    {
        const r = TemplateCatalog.Resolve(Template.DevBlank, 'dev1', 8080, EnvType.Development)
        assert.equal(r.def.kind, EnvKind.Dev)
        assert.equal(r.def.tenantId, 'dev1')
        assert.equal(r.def.purpose, TenantPurposeName.Development)
        assert.ok(existsSync(r.seedDir))
        assert.ok(!existsSync(join(r.seedDir, CatalogFixture.SecurityModel)))
    })

    it('rejects invalid names', () =>
    {
        assert.throws(() => TemplateCatalog.Resolve(Template.DevBlank, 'My Env!', 8080, EnvType.Development), InvalidEnvironmentNameError)
        assert.throws(() => TemplateCatalog.Resolve(Template.DemoContoso, 'My Env!', 8080, EnvType.Runtime), InvalidEnvironmentNameError)
        assert.throws(() => TemplateCatalog.SanitizeName(''), InvalidEnvironmentNameError)
        assert.throws(() => TemplateCatalog.SanitizeName('Dev1'), InvalidEnvironmentNameError)
        assert.throws(() => TemplateCatalog.SanitizeName('a_b'), InvalidEnvironmentNameError)
        assert.equal(TemplateCatalog.SanitizeName('dev-1'), 'dev-1')
    })

    it('lists all templates', () =>
    {
        const all = TemplateCatalog.All()
        assert.deepEqual(all.map(t => t.id).sort(), [Template.DemoContoso, Template.DevBlank].sort())
        for (const t of all)
        {
            assert.ok(t.title.length > 0)
        }
    })

    it('maps the explicit type to the tenant purpose, overriding the template default', () =>
    {
        assert.equal(TemplateCatalog.Resolve(Template.DevBlank, 'e1', 8080, EnvType.Runtime).def.purpose, TenantPurposeName.Runtime)
        assert.equal(TemplateCatalog.Resolve(Template.DemoContoso, 'e2', 8081, EnvType.Development).def.purpose, TenantPurposeName.Development)
    })

    it('still takes kind, seedDir and tenantId from the template', () =>
    {
        const dev = TemplateCatalog.Resolve(Template.DevBlank, 'e1', 8080, EnvType.Runtime)
        assert.equal(dev.def.kind, EnvKind.Dev)
        assert.equal(dev.def.tenantId, 'e1')
        assert.ok(CatalogFixture.Norm(dev.seedDir).endsWith('templates/dev-blank'))
        const demo = TemplateCatalog.Resolve(Template.DemoContoso, 'e2', 8081, EnvType.Development)
        assert.equal(demo.def.kind, EnvKind.Demo)
        assert.equal(demo.def.tenantId, 'contoso')
        assert.ok(CatalogFixture.Norm(demo.seedDir).endsWith(CatalogFixture.DemoSuffix))
    })

    it('DefaultTypeFor mirrors the historical template purpose', () =>
    {
        assert.equal(TemplateCatalog.DefaultTypeFor(Template.DevBlank), EnvType.Development)
        assert.equal(TemplateCatalog.DefaultTypeFor(Template.DemoContoso), EnvType.Runtime)
    })
})
