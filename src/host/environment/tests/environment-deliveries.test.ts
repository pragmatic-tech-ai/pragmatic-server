import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DeliveryChannel } from '@pragmatic-tech-ai/todl/engine'
import { EnvironmentFixture } from './environment-fixture.js'

class DeliveriesFx
{
    public static readonly Crm = { id: 'crm', version: '1.0.0' }
    public static readonly Notes = { id: 'notes', version: '2.0.0' }
    public static readonly Ref = { id: 'ref', version: '1.0.0' }

    /** A legacy app: `application.json` at the app root and no `live` pointer. */
    public static Legacy(fx: EnvironmentFixture, app: string): void
    {
        mkdirSync(join(fx.AppsDir, app), { recursive: true })
        writeFileSync(join(fx.AppsDir, app, 'application.json'), JSON.stringify({ name: app, version: '1.0.0', packages: [DeliveriesFx.Crm] }))
    }

    public static async Run(body: (fx: EnvironmentFixture) => Promise<void>): Promise<void>
    {
        const fx = new EnvironmentFixture()
        try
        {
            await body(fx)
        }
        finally
        {
            await fx.Dispose()
        }
    }
}

describe('environment deliveries', () =>
{
    test('one delivery per live app plus the promote record', async () =>
    {
        await DeliveriesFx.Run(async fx =>
        {
            const deliveries = fx.Deliveries()
            assert.deepEqual(await deliveries.Current(), [], 'nothing live, nothing promoted')
            fx.Live('beta', '2.0.0', [DeliveriesFx.Notes])
            fx.Live('alpha', '1.0.0', [DeliveriesFx.Crm])
            DeliveriesFx.Legacy(fx, 'legacy')
            await fx.Promote('set1', [DeliveriesFx.Ref])
            assert.deepEqual(await deliveries.Current(), [
                { Channel: DeliveryChannel.Deploy, Name: 'alpha', Packages: [{ model: 'crm', version: '1.0.0' }] },
                { Channel: DeliveryChannel.Deploy, Name: 'beta', Packages: [{ model: 'notes', version: '2.0.0' }] },
                { Channel: DeliveryChannel.Promote, Name: 'set1', Packages: [{ model: 'ref', version: '1.0.0' }] },
            ], 'live apps by name, then the promote record; an app without a live pointer is not delivered')
            // With: a deploy replaces the same-named app only; a promote replaces the promote set whatever its name
            const redeploy = await deliveries.With({ Channel: DeliveryChannel.Deploy, Name: 'alpha', Packages: [{ model: 'crm', version: '1.1.0' }] })
            assert.deepEqual(redeploy.map(d => [d.Name, d.Packages[0]!.version]), [['alpha', '1.1.0'], ['beta', '2.0.0'], ['set1', '1.0.0']])
            const promote = await deliveries.With({ Channel: DeliveryChannel.Promote, Name: 'set2', Packages: [{ model: 'ref', version: '1.0.0' }] })
            assert.deepEqual(promote.map(d => [d.Channel, d.Name]), [[DeliveryChannel.Deploy, 'alpha'], [DeliveryChannel.Deploy, 'beta'], [DeliveryChannel.Promote, 'set2']])
            assert.equal((await deliveries.Current()).length, 3, 'With persists nothing')
        })
    })
})
