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
    public static readonly Alpha = 'alpha'
    public static readonly Beta = 'beta'
    public static readonly Legacy = 'legacy'
    public static readonly Set1 = 'set1'
    public static readonly Set2 = 'set2'
    public static readonly V1 = '1.0.0'
    public static readonly V2 = '2.0.0'
    public static readonly V11 = '1.1.0'
    private static readonly ManifestFile = 'application.json'

    /** A legacy app: `application.json` at the app root and no `live` pointer. */
    public static WriteLegacy(fx: EnvironmentFixture, app: string): void
    {
        mkdirSync(join(fx.AppsDir, app), { recursive: true })
        writeFileSync(join(fx.AppsDir, app, DeliveriesFx.ManifestFile), JSON.stringify({ name: app, version: DeliveriesFx.V1, packages: [DeliveriesFx.Crm] }))
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
            fx.Live(DeliveriesFx.Beta, DeliveriesFx.V2, [DeliveriesFx.Notes])
            fx.Live(DeliveriesFx.Alpha, DeliveriesFx.V1, [DeliveriesFx.Crm])
            DeliveriesFx.WriteLegacy(fx, DeliveriesFx.Legacy)
            await fx.Promote(DeliveriesFx.Set1, [DeliveriesFx.Ref])
            assert.deepEqual(await deliveries.Current(), [
                { Channel: DeliveryChannel.Deploy, Name: DeliveriesFx.Alpha, Packages: [{ model: DeliveriesFx.Crm.id, version: DeliveriesFx.V1 }] },
                { Channel: DeliveryChannel.Deploy, Name: DeliveriesFx.Beta, Packages: [{ model: DeliveriesFx.Notes.id, version: DeliveriesFx.V2 }] },
                { Channel: DeliveryChannel.Promote, Name: DeliveriesFx.Set1, Packages: [{ model: DeliveriesFx.Ref.id, version: DeliveriesFx.V1 }] },
            ], 'live apps by name, then the promote record; an app without a live pointer is not delivered')
            // With: a deploy replaces the same-named app only; a promote replaces the promote set whatever its name
            const redeploy = await deliveries.With({ Channel: DeliveryChannel.Deploy, Name: DeliveriesFx.Alpha, Packages: [{ model: DeliveriesFx.Crm.id, version: DeliveriesFx.V11 }] })
            assert.deepEqual(redeploy.map(d => [d.Name, d.Packages[0]!.version]), [[DeliveriesFx.Alpha, DeliveriesFx.V11], [DeliveriesFx.Beta, DeliveriesFx.V2], [DeliveriesFx.Set1, DeliveriesFx.V1]])
            const promote = await deliveries.With({ Channel: DeliveryChannel.Promote, Name: DeliveriesFx.Set2, Packages: [{ model: DeliveriesFx.Ref.id, version: DeliveriesFx.V1 }] })
            assert.deepEqual(promote.map(d => [d.Channel, d.Name]), [[DeliveryChannel.Deploy, DeliveriesFx.Alpha], [DeliveryChannel.Deploy, DeliveriesFx.Beta], [DeliveryChannel.Promote, DeliveriesFx.Set2]])
            assert.equal((await deliveries.Current()).length, 3, 'With persists nothing')
        })
    })
})
