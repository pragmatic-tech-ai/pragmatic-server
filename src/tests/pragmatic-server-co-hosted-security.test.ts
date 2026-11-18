import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EnvironmentPurpose } from '../environments/environment-purpose.js'
import { PragmaticServer } from '../pragmatic-server.js'
import type { PragmaticServerOptions } from '../pragmatic-server.js'

class CoHostedFx
{
    public static readonly KeyEnv = 'PS_CO_HOSTED_SECURITY_KEY'
    public static readonly EnvironmentId = 'env1'
    public static readonly DisplayName = 'Environment One'
    private static readonly RootPrefix = 'ps-cohost-'
    private static readonly Packages = 'packages'
    private static readonly Applications = 'applications'
    private static readonly Graphs = 'graphs'
    private static readonly Identity = 'identity'

    public readonly Root = mkdtempSync(join(tmpdir(), CoHostedFx.RootPrefix))
    private readonly servers: PragmaticServer[] = []

    /** Starts a server over fresh directories; with identity, as a Runtime environment is provisioned (directory sync off). */
    public async Start(purpose: EnvironmentPurpose, runtimeCoHosted: boolean, withIdentity: boolean): Promise<PragmaticServer>
    {
        process.env[CoHostedFx.KeyEnv] = randomBytes(32).toString('base64')
        const options: PragmaticServerOptions = {
            purpose,
            runtimeCoHosted,
            packagesRoot: join(this.Root, CoHostedFx.Packages),
            applicationsRoot: join(this.Root, CoHostedFx.Applications),
            graphsRoot: join(this.Root, CoHostedFx.Graphs),
            ...(withIdentity ? { identity: { identityRoot: join(this.Root, CoHostedFx.Identity), masterKey: { base64Env: CoHostedFx.KeyEnv }, environment: { id: CoHostedFx.EnvironmentId, displayName: CoHostedFx.DisplayName }, directorySyncOnStart: false } } : {}),
        }
        for (const dir of [CoHostedFx.Packages, CoHostedFx.Applications, CoHostedFx.Graphs, CoHostedFx.Identity]) mkdirSync(join(this.Root, dir), { recursive: true })
        const server = new PragmaticServer(options)
        this.servers.push(server)
        await server.Start()
        return server
    }

    public async Dispose(): Promise<void>
    {
        for (const server of this.servers) await server.Dispose()
        rmSync(this.Root, { recursive: true, force: true })
    }
}

let fx: CoHostedFx | undefined

afterEach(async () =>
{
    await fx?.Dispose()
    fx = undefined
})

test('a co-hosted Development server with identity has a SecurityAdmin', async () =>
{
    fx = new CoHostedFx()
    const server = await fx.Start(EnvironmentPurpose.Development, true, true)
    assert.notEqual(await server.SecurityAdmin(), undefined)
})

test('a plain Development server has no SecurityAdmin', async () =>
{
    fx = new CoHostedFx()
    const server = await fx.Start(EnvironmentPurpose.Development, false, true)
    assert.equal(await server.SecurityAdmin(), undefined)
})

test('a co-hosted Development server without identity fails SecurityAdmin like a Runtime server does (misprovisioned)', async () =>
{
    fx = new CoHostedFx()
    const co = await fx.Start(EnvironmentPurpose.Development, true, false)
    const runtime = await fx.Start(EnvironmentPurpose.Runtime, false, false)
    await assert.rejects(() => co.SecurityAdmin())
    await assert.rejects(() => runtime.SecurityAdmin())
})
