import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PragmaticServer } from '../pragmatic-server.js'
import { TenantPurpose } from '../tenancy/tenant-purpose.js'

class ApplicationsServerFixture
{
    private static readonly Prefix = 'srv-apps-'
    public readonly Dir = mkdtempSync(join(tmpdir(), ApplicationsServerFixture.Prefix))

    public Dispose(): void
    {
        rmSync(this.Dir, { recursive: true, force: true })
    }
}

test('Applications throws on a development tenant', () =>
{
    const f = new ApplicationsServerFixture()
    try
    {
        const server = new PragmaticServer({ applicationsRoot: f.Dir })
        assert.throws(() => server.Applications(), /runtime-tenant feature/)
        const dev = new PragmaticServer({ purpose: TenantPurpose.Development, applicationsRoot: f.Dir })
        assert.throws(() => dev.Applications(), /runtime-tenant feature/)
    }
    finally { f.Dispose() }
})

test('Applications and AppsStorage are memoised on a runtime tenant', () =>
{
    const f = new ApplicationsServerFixture()
    try
    {
        const server = new PragmaticServer({ purpose: TenantPurpose.Runtime, applicationsRoot: f.Dir })
        assert.equal(server.Applications(), server.Applications())
        assert.equal(server.AppsStorage(), server.AppsStorage())
    }
    finally { f.Dispose() }
})

test('Applications throws when a runtime tenant has no applicationsRoot', () =>
{
    const server = new PragmaticServer({ purpose: TenantPurpose.Runtime })
    assert.throws(() => server.Applications(), /applicationsRoot is required/)
})
