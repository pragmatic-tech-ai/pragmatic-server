import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PragmaticServer } from '../../../pragmatic-server.js'

class ServerDevEngineFx
{
    public static readonly Prefix = 'ps-devengine-'
    public static readonly Disposed = /disposed/
}

test('the server memoizes its dev engine and refuses one once disposed', async () =>
{
    const packages = mkdtempSync(join(tmpdir(), ServerDevEngineFx.Prefix))
    const server = new PragmaticServer({ packagesRoot: packages })
    try
    {
        const engine = server.DevEngine()
        assert.equal(server.DevEngine(), engine)
        await server.Dispose()
        assert.throws(() => server.DevEngine(), ServerDevEngineFx.Disposed)
        await assert.rejects(engine.Engine(), ServerDevEngineFx.Disposed, 'the memoized host was disposed with the server')
    }
    finally
    {
        await server.Dispose()
        rmSync(packages, { recursive: true, force: true })
    }
})
