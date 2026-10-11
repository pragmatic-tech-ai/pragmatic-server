import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModuleStateKind } from '@pragmatic-tech-ai/todl-runtime'
import { SolutionManagerService } from '@pragmatic-tech-ai/todl'
import { PragmaticServer } from '../pragmatic-server.js'
import { SolutionServicesModule, LanguageServiceModule } from '../composition/server-modules.js'

class ServerFixture
{
    private static readonly TempPrefix = 'ps-pkgs-'
    public static readonly ManagerModule = SolutionServicesModule.ModuleId
    public static readonly LanguageModule = LanguageServiceModule.ModuleId

    public static OverTemp(): PragmaticServer
    {
        const packagesRoot = mkdtempSync(join(tmpdir(), ServerFixture.TempPrefix))
        return new PragmaticServer({ packagesRoot })
    }
}

test('domain module is Dormant before first resolve and Active after', async () =>
{
    const server = ServerFixture.OverTemp()
    await server.Start()
    assert.equal(server.StateOf(ServerFixture.ManagerModule)?.Get().Kind, ModuleStateKind.Dormant)
    const manager = await server.Manager()
    assert.ok(manager instanceof SolutionManagerService)
    assert.equal(server.StateOf(ServerFixture.ManagerModule)?.Get().Kind, ModuleStateKind.Active)
    await server.Dispose()
})

test('LanguageService resolves and activates its required solution-manager module', async () =>
{
    const server = ServerFixture.OverTemp()
    await server.Start()
    const ls = await server.LanguageService()
    assert.ok(ls)
    assert.equal(server.StateOf(ServerFixture.LanguageModule)?.Get().Kind, ModuleStateKind.Active)
    assert.equal(server.StateOf(ServerFixture.ManagerModule)?.Get().Kind, ModuleStateKind.Active)
    await server.Dispose()
})
