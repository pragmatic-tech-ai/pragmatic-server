import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, get } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The platform edge (its own entry, bin/pragmatic-platform-edged) is stateless: it must start with no database setting. */
class EdgeProcessFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly Server = join(EdgeProcessFixture.Here, '..', 'bin', 'pragmatic-platform-edged.ts')
    public static readonly TsxCli = join(EdgeProcessFixture.Here, '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')
    public static readonly ListeningLine = 'Edge listening on '
    public static readonly StartTimeoutMs = 60_000

    public static FreePort(): Promise<number>
    {
        return new Promise((resolve, reject) =>
        {
            const server = createServer()
            server.once('error', reject)
            server.listen(0, '127.0.0.1', () =>
            {
                const port = (server.address() as AddressInfo).port
                server.close(() => resolve(port))
            })
        })
    }

    public static Health(port: number): Promise<number>
    {
        return new Promise((resolve, reject) =>
        {
            get({ host: '127.0.0.1', port, path: '/healthz' }, res =>
            {
                res.resume()
                resolve(res.statusCode ?? 0)
            }).on('error', reject)
        })
    }
}

describe('the platform edge without a database', () =>
{
    it('starts from server.ts with no PRAGMATIC_ADMIN_DATABASE_URL_FILE and answers /healthz', async () =>
    {
        const F = EdgeProcessFixture
        const dir = mkdtempSync(join(tmpdir(), 'edge-nodb-'))
        const secret = join(dir, 'secret')
        writeFileSync(secret, 'e'.repeat(48))
        const port = await F.FreePort()
        const env: NodeJS.ProcessEnv = { ...process.env, PRAGMATIC_AGENT_CHANNEL_PORT: String(port), PRAGMATIC_AGENT_CHANNEL_BIND: '127.0.0.1',
            PRAGMATIC_EDGE_ADMIN_URL: 'http://127.0.0.1:1', PRAGMATIC_INTERNAL_API_SECRET_FILE: secret }
        delete env.PRAGMATIC_ADMIN_DATABASE_URL_FILE
        const child = spawn(process.execPath, [F.TsxCli, F.Server], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        try
        {
            const output: string[] = []
            await new Promise<void>((resolve, reject) =>
            {
                const timer = setTimeout(() => reject(new Error('edge did not start: ' + output.join(''))), F.StartTimeoutMs)
                const seen = (chunk: Buffer): void =>
                {
                    output.push(chunk.toString())
                    if (output.join('').includes(F.ListeningLine))
                    {
                        clearTimeout(timer)
                        resolve()
                    }
                }
                child.stdout.on('data', seen)
                child.stderr.on('data', seen)
                child.once('exit', code => { clearTimeout(timer); reject(new Error('edge exited ' + String(code) + ': ' + output.join(''))) })
            })
            assert.equal(await F.Health(port), 200)
        }
        finally
        {
            child.kill()
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
