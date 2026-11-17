import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ILanguageService } from '@pragmatic-tech-ai/todl/solution-services/lsp'
import { PragmaticServer } from '../../pragmatic-server.js'

class BridgeServer extends PragmaticServer
{
    public LanguageServiceCalls = 0

    public override async LanguageService(): Promise<ILanguageService>
    {
        this.LanguageServiceCalls++
        await new Promise(resolve => setTimeout(resolve, 10))
        return {} as unknown as ILanguageService
    }
}

test('concurrent first DevSourceChangeBridge calls share one bridge', async () =>
{
    const server = new BridgeServer({})
    const [a, b] = await Promise.all([server.DevSourceChangeBridge(), server.DevSourceChangeBridge()])
    assert.equal(a, b)
    assert.equal(server.LanguageServiceCalls, 1)
    assert.equal(await server.DevSourceChangeBridge(), a)
})
