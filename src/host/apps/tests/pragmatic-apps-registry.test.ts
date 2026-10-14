import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { PragmaticAppsRegistry } from '../pragmatic-apps-registry.js'
import { PragmaticAppManifestParser } from '../pragmatic-app-manifest.js'

class AppsFixture
{
    private static readonly Prefix = 'apps-'
    private static readonly ManifestFile = 'application.json'
    private static readonly DemoManifest = '{"name":"demo","version":"1.0.0","packages":[{"id":"acme.catalog","version":"1.0.0"}]}'

    public readonly Dir = mkdtempSync(join(tmpdir(), AppsFixture.Prefix))

    public AddApp(name: string, manifest: string = AppsFixture.DemoManifest): void
    {
        mkdirSync(join(this.Dir, name))
        writeFileSync(join(this.Dir, name, AppsFixture.ManifestFile), manifest)
    }

    public Registry(): PragmaticAppsRegistry
    {
        return new PragmaticAppsRegistry(new NodeFsStorage(this.Dir))
    }

    public Dispose(): void
    {
        rmSync(this.Dir, { recursive: true, force: true })
    }
}

test('List returns name and version of each application', async () =>
{
    const f = new AppsFixture()
    try
    {
        f.AddApp('demo')
        assert.deepEqual(await f.Registry().List(), [{ name: 'demo', version: '1.0.0' }])
    }
    finally { f.Dispose() }
})

test('ApplicationFor loads the manifest', async () =>
{
    const f = new AppsFixture()
    try
    {
        f.AddApp('demo')
        const app = await f.Registry().ApplicationFor('demo')
        assert.equal(app.Manifest.packages[0].id, 'acme.catalog')
    }
    finally { f.Dispose() }
})

test('ApplicationFor rejects an unknown application', async () =>
{
    const f = new AppsFixture()
    try
    {
        await assert.rejects(f.Registry().ApplicationFor('missing'), /not found/)
    }
    finally { f.Dispose() }
})

test('malformed manifest fails closed', async () =>
{
    const f = new AppsFixture()
    try
    {
        f.AddApp('bad', '{"name":"demo"}')
        await assert.rejects(f.Registry().ApplicationFor('bad'))
        assert.throws(() => PragmaticAppManifestParser.Parse('{"name":"demo","version":"1","packages":[{"id":""}]}'))
        assert.throws(() => PragmaticAppManifestParser.Parse('not json'))
    }
    finally { f.Dispose() }
})
