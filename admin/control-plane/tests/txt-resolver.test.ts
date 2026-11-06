import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DomainCheck, DomainTxtVerifier, NodeTxtResolver, TxtLookupStatus } from '../txt-resolver.js'
import type { IDnsTxtBackend, ITxtResolver, TxtLookup } from '../txt-resolver.js'

const Deadline = 20
const Token = 'A'.repeat(42) + '_'

/** A backend whose lookup answers through a supplied promise; counts cancel() and never settles anything on cancel. */
class FakeBackend implements IDnsTxtBackend
{
    public cancels = 0
    public queried: string[] = []

    public constructor(private readonly answer: () => Promise<string[][]>) {}

    public resolveTxt(name: string): Promise<string[][]>
    {
        this.queried.push(name)
        return this.answer()
    }

    public cancel(): void
    {
        this.cancels++
    }

    public static Rejecting(code: string | undefined): FakeBackend
    {
        return new FakeBackend(() => Promise.reject(code === undefined ? new Error('boom') : Object.assign(new Error(), { code })))
    }

    public static Hanging(): FakeBackend
    {
        return new FakeBackend(() => new Promise<string[][]>(() => {}))
    }
}

/** Records every queried name and answers a fixed lookup. */
class FakeTxtResolver implements ITxtResolver
{
    public queried: string[] = []

    public constructor(private readonly lookup: TxtLookup) {}

    public async ResolveTxt(name: string): Promise<TxtLookup>
    {
        this.queried.push(name)
        return this.lookup
    }
}

test('NodeTxtResolver answers Found with the records', async () =>
{
    const backend = new FakeBackend(async () => [['a', 'b']])
    const lookup = await new NodeTxtResolver(() => backend, Deadline).ResolveTxt('_pragmatic-verification.acme.test')
    assert.deepEqual(lookup, { status: TxtLookupStatus.Found, records: [['a', 'b']] })
    assert.deepEqual(backend.queried, ['_pragmatic-verification.acme.test'])
    assert.equal(backend.cancels, 0)
})

test('an empty record list reads as NoRecord', async () =>
{
    const lookup = await new NodeTxtResolver(() => new FakeBackend(async () => []), Deadline).ResolveTxt('x.acme.test')
    assert.deepEqual(lookup, { status: TxtLookupStatus.NoRecord, records: [] })
})

test('ENODATA and ENOTFOUND read as NoRecord', async () =>
{
    for (const code of ['ENODATA', 'ENOTFOUND'])
    {
        const lookup = await new NodeTxtResolver(() => FakeBackend.Rejecting(code), Deadline).ResolveTxt('x.acme.test')
        assert.deepEqual(lookup, { status: TxtLookupStatus.NoRecord, records: [] }, code)
    }
})

test('ETIMEOUT, ESERVFAIL and unknown errors read as Failed', async () =>
{
    for (const code of ['ETIMEOUT', 'ESERVFAIL', 'ECANCELLED', undefined])
    {
        const lookup = await new NodeTxtResolver(() => FakeBackend.Rejecting(code), Deadline).ResolveTxt('x.acme.test')
        assert.deepEqual(lookup, { status: TxtLookupStatus.Failed, records: [] }, String(code))
    }
})

test('a rejection without a code (a string, null) reads as Failed', async () =>
{
    for (const reason of ['ENODATA', null])
    {
        const backend = new FakeBackend(() => Promise.reject(reason))
        const lookup = await new NodeTxtResolver(() => backend, Deadline).ResolveTxt('x.acme.test')
        assert.deepEqual(lookup, { status: TxtLookupStatus.Failed, records: [] }, String(reason))
    }
})

test('a backend that throws synchronously reads as Failed', async () =>
{
    const backend = new FakeBackend(() => { throw new Error('sync') })
    const lookup = await new NodeTxtResolver(() => backend, Deadline).ResolveTxt('x.acme.test')
    assert.deepEqual(lookup, { status: TxtLookupStatus.Failed, records: [] })
})

test('a backend that never settles reads as Failed after the deadline and is cancelled', async () =>
{
    const backend = FakeBackend.Hanging()
    const lookup = await new NodeTxtResolver(() => backend, Deadline).ResolveTxt('x.acme.test')
    assert.deepEqual(lookup, { status: TxtLookupStatus.Failed, records: [] })
    assert.equal(backend.cancels, 1)
})

test('a lookup rejecting after its deadline leaves no unhandled rejection', async () =>
{
    let reject: (reason: unknown) => void = () => {}
    const backend = new FakeBackend(() => new Promise<string[][]>((_resolve, fail) => { reject = fail }))
    const unhandled: unknown[] = []
    const listener = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', listener)
    try
    {
        const lookup = await new NodeTxtResolver(() => backend, Deadline).ResolveTxt('x.acme.test')
        assert.equal(lookup.status, TxtLookupStatus.Failed)
        reject(Object.assign(new Error(), { code: 'ECANCELLED' }))
        await new Promise(resolve => setTimeout(resolve, Deadline))
        assert.deepEqual(unhandled, [])
    }
    finally
    {
        process.off('unhandledRejection', listener)
    }
})

test('each lookup gets its own backend, so one hitting the deadline does not cancel another', async () =>
{
    const hanging = FakeBackend.Hanging()
    let release: (records: string[][]) => void = () => {}
    const slow = new FakeBackend(() => new Promise<string[][]>(resolve => { release = resolve }))
    const backends = [hanging, slow]
    const resolver = new NodeTxtResolver(() => backends.shift() as FakeBackend, Deadline * 5)
    const first = resolver.ResolveTxt('a.acme.test')
    const second = resolver.ResolveTxt('b.acme.test')
    assert.deepEqual(await first, { status: TxtLookupStatus.Failed, records: [] })
    release([['ok']])
    assert.deepEqual(await second, { status: TxtLookupStatus.Found, records: [['ok']] })
    assert.equal(hanging.cancels, 1)
    assert.equal(slow.cancels, 0)
})

test('DomainTxtVerifier maps Found+match to Verified, Found without match to Mismatch, NoRecord to Absent, Failed to Failed', async () =>
{
    const cases: [TxtLookup, DomainCheck][] = [
        [{ status: TxtLookupStatus.Found, records: [['v=spf1 -all'], ['pragmatic-domain-verification=' + Token]] }, DomainCheck.Verified],
        [{ status: TxtLookupStatus.Found, records: [['pragmatic-domain-verification=other']] }, DomainCheck.Mismatch],
        [{ status: TxtLookupStatus.NoRecord, records: [] }, DomainCheck.Absent],
        [{ status: TxtLookupStatus.Found, records: [] }, DomainCheck.Absent],
        [{ status: TxtLookupStatus.Failed, records: [] }, DomainCheck.Failed],
    ]
    for (const [lookup, expected] of cases)
    {
        const resolver = new FakeTxtResolver(lookup)
        assert.equal(await new DomainTxtVerifier(resolver).Check('Acme.TEST.', Token), expected, JSON.stringify(lookup))
        assert.deepEqual(resolver.queried, ['_pragmatic-verification.acme.test'])
    }
})

test('DomainTxtVerifier answers Failed without a lookup for a token outside TokenPattern or a malformed domain', async () =>
{
    const bare: TxtLookup = { status: TxtLookupStatus.Found, records: [['pragmatic-domain-verification=']] }
    const cases: [string, string][] = [['acme.test', ''], ['acme.test', 'short'], ['acme.test', Token + '='], ['acme..test', Token], ['', Token]]
    for (const [domain, token] of cases)
    {
        const resolver = new FakeTxtResolver(bare)
        assert.equal(await new DomainTxtVerifier(resolver).Check(domain, token), DomainCheck.Failed, JSON.stringify([domain, token]))
        assert.deepEqual(resolver.queried, [])
    }
})
