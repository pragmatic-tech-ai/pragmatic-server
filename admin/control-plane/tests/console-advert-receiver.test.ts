import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConsoleAdvertReceiver, ConsoleNotEnabledError, InvalidConsoleAdvertError } from '../console-advert-receiver.js'
import type { IConsoleAdvertDirectory } from '../console-advert-receiver.js'
import { ConsoleAdvertRegistry } from '../console-advert-registry.js'
import { IngressTlsSource } from '../ingress-tls.js'
import type { HiveRecord } from '../platform-records.js'

const Fp = 'c'.repeat(64)
const GoodUrl = 'https://console-acme.localtest.me'

class ReceiverFixture
{
    public dir = ''
    public registry!: ConsoleAdvertRegistry
    public receiver!: ConsoleAdvertReceiver

    public static async Run(body: (f: ReceiverFixture) => Promise<void>, withConsole = true, specOver: Record<string, unknown> = {}): Promise<void>
    {
        const f = new ReceiverFixture()
        f.dir = await mkdtemp(join(tmpdir(), 'advert-receiver-'))
        f.registry = new ConsoleAdvertRegistry(join(f.dir, ConsoleAdvertRegistry.FileName))
        const hive = {
            id: 'h1',
            tenantId: 'acme',
            ...(withConsole ? { console: { baseDomain: 'localtest.me', tls: { source: IngressTlsSource.Development }, ...specOver } } : {}),
        } as unknown as HiveRecord
        const directory: IConsoleAdvertDirectory = { GetHive: id => (id === 'h1' ? hive : undefined) }
        f.receiver = new ConsoleAdvertReceiver(directory, f.registry, () => new Date('2026-11-04T12:00:00.000Z'))
        try
        {
            await body(f)
        }
        finally
        {
            await rm(f.dir, { recursive: true, force: true })
        }
    }

    public static Body(over: Record<string, unknown> = {}): Record<string, unknown>
    {
        return { consoleUrl: GoodUrl, fingerprints: [Fp], emailDomains: ['acme.test'], ...over }
    }
}

test('stores a valid advert with the host lower-cased', async () =>
{
    await ReceiverFixture.Run(async f =>
    {
        const outcome = await f.receiver.Receive('h1', ReceiverFixture.Body({ consoleUrl: 'https://Console-Acme.localtest.me/' }))
        assert.equal(outcome.record.consoleUrl, GoodUrl)
        assert.equal(outcome.record.tenantId, 'acme')
        assert.equal(outcome.record.hiveId, 'h1')
        assert.equal(outcome.record.reportedAt, '2026-11-04T12:00:00.000Z')
        assert.equal(f.registry.List().length, 1)
    })
})

test('refuses a hive without the console enabled', async () =>
{
    await ReceiverFixture.Run(async f =>
    {
        await assert.rejects(() => f.receiver.Receive('h1', ReceiverFixture.Body()), ConsoleNotEnabledError)
        await assert.rejects(() => f.receiver.Receive('nope', ReceiverFixture.Body()), ConsoleNotEnabledError)
        assert.equal(f.registry.List().length, 0)
    }, false)
})

test('refuses another host, http, a path, a query, a port or user info and keeps the previous advert', async () =>
{
    await ReceiverFixture.Run(async f =>
    {
        await f.receiver.Receive('h1', ReceiverFixture.Body())
        const bad = ['https://evil.test', 'http://console-acme.localtest.me', 'https://console-acme.localtest.me/x', 'https://console-acme.localtest.me/?a=1',
            'https://console-acme.localtest.me:8443', 'https://u:p@console-acme.localtest.me', 'https://' + 'a'.repeat(2050), 'not a url']
        for (const consoleUrl of bad)
        {
            await assert.rejects(() => f.receiver.Receive('h1', ReceiverFixture.Body({ consoleUrl, fingerprints: [] })), InvalidConsoleAdvertError, consoleUrl)
        }
        assert.equal((f.registry.ForTenant('acme') as { reportedAt: string }).reportedAt, '2026-11-04T12:00:00.000Z')
        assert.deepEqual(f.registry.ForTenant('acme')?.fingerprints, [Fp])
    })
})

test('refuses a body of the wrong shape', async () =>
{
    await ReceiverFixture.Run(async f =>
    {
        const bodies: unknown[] = [undefined, null, [], 'x', { consoleUrl: GoodUrl }, ReceiverFixture.Body({ consoleUrl: 5 }),
            ReceiverFixture.Body({ fingerprints: 'x' }), ReceiverFixture.Body({ emailDomains: [1] })]
        for (const body of bodies)
        {
            await assert.rejects(() => f.receiver.Receive('h1', body), InvalidConsoleAdvertError)
        }
    })
})

test('refuses malformed or too many fingerprints', async () =>
{
    await ReceiverFixture.Run(async f =>
    {
        const bad = [['a'.repeat(63)], ['A'.repeat(64)], Array.from({ length: 10001 }, (_, i) => i.toString(16).padStart(64, '0'))]
        for (const fingerprints of bad)
        {
            await assert.rejects(() => f.receiver.Receive('h1', ReceiverFixture.Body({ fingerprints })), InvalidConsoleAdvertError)
        }
        assert.equal(f.registry.List().length, 0)
    })
})

test('dedupes fingerprints', async () =>
{
    await ReceiverFixture.Run(async f =>
    {
        const outcome = await f.receiver.Receive('h1', ReceiverFixture.Body({ fingerprints: ['d'.repeat(64), Fp, Fp] }))
        assert.deepEqual(outcome.record.fingerprints, [Fp, 'd'.repeat(64)])
    })
})

test('drops refused email domains and reports them', async () =>
{
    await ReceiverFixture.Run(async f =>
    {
        const outcome = await f.receiver.Receive('h1', ReceiverFixture.Body({ emailDomains: ['acme.test', 'gmail.com', 'bad..x'] }))
        assert.deepEqual(outcome.record.emailDomains, ['acme.test'])
        assert.deepEqual(outcome.refusedEmailDomains, ['gmail.com', 'bad..x'])
    })
})

test('refuses more than 20 email domains', async () =>
{
    await ReceiverFixture.Run(async f =>
    {
        const emailDomains = Array.from({ length: 21 }, (_, i) => `d${i}.acme.test`)
        await assert.rejects(() => f.receiver.Receive('h1', ReceiverFixture.Body({ emailDomains })), InvalidConsoleAdvertError)
    })
})

test('error messages never carry submitted values', async () =>
{
    await ReceiverFixture.Run(async f =>
    {
        await assert.rejects(
            () => f.receiver.Receive('h1', ReceiverFixture.Body({ consoleUrl: 'https://evil.test', fingerprints: [Fp] })),
            (err: Error) => !err.message.includes('evil.test') && !err.message.includes(Fp))
        await assert.rejects(
            () => f.receiver.Receive('h1', ReceiverFixture.Body({ fingerprints: ['zz' + Fp] })),
            (err: Error) => !err.message.includes(Fp))
    })
})

test('an explicit host override is the expected host', async () =>
{
    await ReceiverFixture.Run(async f =>
    {
        const outcome = await f.receiver.Receive('h1', ReceiverFixture.Body({ consoleUrl: 'https://Tenant.Localtest.me' }))
        assert.equal(outcome.record.consoleUrl, 'https://tenant.localtest.me')
        await assert.rejects(() => f.receiver.Receive('h1', ReceiverFixture.Body()), InvalidConsoleAdvertError)
    }, true, { host: 'tenant.localtest.me' })
})

test('a spec with an ingressNamespace still expects the derived host', async () =>
{
    await ReceiverFixture.Run(async f =>
    {
        const outcome = await f.receiver.Receive('h1', ReceiverFixture.Body())
        assert.equal(outcome.record.consoleUrl, GoodUrl)
    }, true, { ingressNamespace: 'ingress-nginx' })
})

/** A registry that lets the hive lose its console while a report is in flight (a removal racing the advert). */
class RacingRegistry extends ConsoleAdvertRegistry
{
    public constructor(filePath: string, private readonly race: () => void)
    {
        super(filePath)
    }

    public override async Report(...args: Parameters<ConsoleAdvertRegistry['Report']>): ReturnType<ConsoleAdvertRegistry['Report']>
    {
        this.race()
        await Promise.resolve()
        return await super.Report(...args)
    }
}

test('refuses an advert whose hive lost its console before the write, so a late advert cannot outlive the removal', async () =>
{
    const dir = await mkdtemp(join(tmpdir(), 'advert-receiver-race-'))
    try
    {
        let hive: HiveRecord | undefined = {
            id: 'h1', tenantId: 'acme', console: { baseDomain: 'localtest.me', tls: { source: IngressTlsSource.Development } },
        } as unknown as HiveRecord
        const directory: IConsoleAdvertDirectory = { GetHive: id => (id === 'h1' ? hive : undefined) }
        for (const race of [() => { hive = { ...hive, console: undefined } as unknown as HiveRecord }, () => { hive = undefined }])
        {
            hive = { id: 'h1', tenantId: 'acme', console: { baseDomain: 'localtest.me', tls: { source: IngressTlsSource.Development } } } as unknown as HiveRecord
            const registry = new RacingRegistry(join(dir, ConsoleAdvertRegistry.FileName), race)
            const receiver = new ConsoleAdvertReceiver(directory, registry, () => new Date('2026-11-04T12:00:00.000Z'))
            await assert.rejects(() => receiver.Receive('h1', ReceiverFixture.Body()), ConsoleNotEnabledError)
            assert.equal(registry.List().length, 0)
        }
    }
    finally
    {
        await rm(dir, { recursive: true, force: true })
    }
})
