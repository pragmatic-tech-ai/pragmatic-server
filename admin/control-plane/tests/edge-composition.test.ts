import { strict as assert } from 'node:assert'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { EventEmitter } from 'node:events'
import { EdgeComposition, EdgeShutdown } from '../edge-composition.js'

class CompositionFixture
{
    public static readonly Root = mkdtempSync(join(tmpdir(), 'edge-compose-'))

    public static Env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv
    {
        const secret = join(CompositionFixture.Root, 'secret')
        writeFileSync(secret, 'e'.repeat(48))
        const env: NodeJS.ProcessEnv = {
            PRAGMATIC_CONTROL_PLANE_ROLE: 'edge',
            PRAGMATIC_AGENT_CHANNEL_PORT: '7100',
            PRAGMATIC_AGENT_CHANNEL_BIND: '127.0.0.1',
            PRAGMATIC_EDGE_ADMIN_URL: 'http://127.0.0.1:1',
            PRAGMATIC_INTERNAL_API_SECRET_FILE: secret,
        }
        for (const [k, v] of Object.entries(overrides))
        {
            if (v === undefined)
            {
                delete env[k]
            }
            else
            {
                env[k] = v
            }
        }
        return env
    }
}

describe('EdgeComposition', () =>
{
    after(() =>
    {
        try
        {
            chmodSync(join(CompositionFixture.Root, 'ro'), 0o700)
        }
        catch
        {
            // not created on this platform
        }
        rmSync(CompositionFixture.Root, { recursive: true, force: true })
    })

    it('starts with no data root: a data-root setting under a read-only directory is never touched', async () =>
    {
        const ro = join(CompositionFixture.Root, 'ro')
        mkdirSync(ro)
        chmodSync(ro, 0o500)
        const dataRoot = join(ro, 'data')
        const edge = EdgeComposition.Compose(CompositionFixture.Env({ PRAGMATIC_ADMIN_DATA_ROOT: dataRoot, PRAGMATIC_EDGE_TRUSTED_PROXY: 'true' }))
        assert.equal(edge.Port, 7100)
        await edge.Host.Listen(0, edge.Bind)
        try
        {
            assert.ok(edge.Host.Address().port > 0)
            assert.equal(existsSync(dataRoot), false)
        }
        finally
        {
            await edge.Host.Close()
        }
    })

    it('names each missing or invalid required setting', () =>
    {
        assert.throws(() => EdgeComposition.Compose(CompositionFixture.Env({ PRAGMATIC_EDGE_ADMIN_URL: undefined })), /PRAGMATIC_EDGE_ADMIN_URL/)
        assert.throws(() => EdgeComposition.Compose(CompositionFixture.Env({ PRAGMATIC_EDGE_ADMIN_URL: 'not a url' })), /PRAGMATIC_EDGE_ADMIN_URL/)
        assert.throws(() => EdgeComposition.Compose(CompositionFixture.Env({ PRAGMATIC_INTERNAL_API_SECRET_FILE: undefined })), /PRAGMATIC_INTERNAL_API_SECRET_FILE/)
        assert.throws(() => EdgeComposition.Compose(CompositionFixture.Env({ PRAGMATIC_INTERNAL_API_SECRET_FILE: join(CompositionFixture.Root, 'missing') })), /PRAGMATIC_INTERNAL_API_SECRET_FILE/)
        assert.throws(() => EdgeComposition.Compose(CompositionFixture.Env({ PRAGMATIC_AGENT_CHANNEL_PORT: undefined })), /PRAGMATIC_AGENT_CHANNEL_PORT/)
        assert.throws(() => EdgeComposition.Compose(CompositionFixture.Env({ PRAGMATIC_AGENT_CHANNEL_PORT: '0' })), /PRAGMATIC_AGENT_CHANNEL_PORT/)
    })

    it('reads the trusted-proxy switch', () =>
    {
        assert.equal(EdgeComposition.Compose(CompositionFixture.Env()).TrustedProxy, false)
        assert.equal(EdgeComposition.Compose(CompositionFixture.Env({ PRAGMATIC_EDGE_TRUSTED_PROXY: '1' })).TrustedProxy, true)
        assert.equal(EdgeComposition.Compose(CompositionFixture.Env({ PRAGMATIC_EDGE_TRUSTED_PROXY: 'true' })).TrustedProxy, true)
    })
})

class FakeProcess extends EventEmitter
{
    public Exited: number | undefined

    public exit(code: number): never
    {
        this.Exited = code
        return undefined as never
    }
}

describe('EdgeShutdown', () =>
{
    it('closes the edge listener and exits 128+n on SIGTERM and SIGINT', async () =>
    {
        for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const)
        {
            const proc = new FakeProcess()
            let closed = 0
            EdgeShutdown.Install({ Close: async () => { closed++ } }, proc as unknown as NodeJS.Process)
            proc.emit(signal)
            await new Promise(r => setImmediate(r))
            assert.equal(closed, 1, signal)
            assert.equal(proc.Exited, code, signal)
        }
    })

    it('still exits when closing the listener fails', async () =>
    {
        const proc = new FakeProcess()
        EdgeShutdown.Install({ Close: async () => { throw new Error('busy') } }, proc as unknown as NodeJS.Process)
        proc.emit('SIGTERM')
        await new Promise(r => setImmediate(r))
        assert.equal(proc.Exited, 143)
    })
})
