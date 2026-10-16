import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { TemplateCatalog, InvalidEnvironmentNameError } from '../template-catalog.js'
import { Template } from '../environment-record.js'
import { EnvKind, TenantPurposeName } from '../../../environments/seed/bundle.js'

class CatalogFixture
{
    public static readonly SecurityModel = 'security-model.json'
    public static readonly DemoSuffix = 'environments/demo/seed'

    public static Norm(p: string): string
    {
        return p.replace(/\/g, '/')
    }
}

describe('TemplateCatalog', () =>
{
    it('resolves demo-contoso', () =>
    {
        const r = TemplateCatalog.Resolve(Template.DemoContoso, 'demo1', 8081)
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
        const r = TemplateCatalog.Resolve(Template.DevBlank, 'dev1', 8080)
        assert.equal(r.def.kind, EnvKind.Dev)
        assert.equal(r.def.tenantId, 'dev1')
        assert.equal(r.def.purpose, TenantPurposeName.Development)
        assert.ok(existsSync(r.seedDir))
        assert.ok(!existsSync(join(r.seedDir, CatalogFixture.SecurityModel)))
    })

    it('rejects invalid names', () =>
    {
        assert.throws(() => TemplateCatalog.Resolve(Template.DevBlank, 'My Env!', 8080), InvalidEnvironmentNameError)
        assert.throws(() => TemplateCatalog.Resolve(Template.DemoContoso, 'My Env!', 8080), InvalidEnvironmentNameError)
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
})
