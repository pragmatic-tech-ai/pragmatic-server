import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PragmaticServer } from '../pragmatic-server.js'
import { EnvironmentPurpose } from '../environments/environment-purpose.js'

class ApplicationsServerFixture
{
    private static readonly Prefix = 'srv-apps-'
    public readonly Dir = mkdtempSync(join(tmpdir(), ApplicationsServerFixture.Prefix))

    public Dispose(): void
    {
        rmSync(this.Dir, { recursive: true, force: true })
    }
}

test('Applications throws on a development environment', () =>
{
    const f = new ApplicationsServerFixture()
    try
    {
        const server = new PragmaticServer({ applicationsRoot: f.Dir })
        assert.throws(() => server.Applications(), /runtime-environment feature/)
        const dev = new PragmaticServer({ purpose: EnvironmentPurpose.Development, applicationsRoot: f.Dir })
        assert.throws(() => dev.Applications(), /runtime-environment feature/)
    }
    finally { f.Dispose() }
})

test('Applications and AppsStorage are memoised on a runtime environment', () =>
{
    const f = new ApplicationsServerFixture()
    try
    {
        const server = new PragmaticServer({ purpose: EnvironmentPurpose.Runtime, applicationsRoot: f.Dir })
        assert.equal(server.Applications(), server.Applications())
        assert.equal(server.AppsStorage(), server.AppsStorage())
    }
    finally { f.Dispose() }
})

test('Applications throws when a runtime environment has no applicationsRoot', () =>
{
    const server = new PragmaticServer({ purpose: EnvironmentPurpose.Runtime })
    assert.throws(() => server.Applications(), /applicationsRoot is required/)
})
