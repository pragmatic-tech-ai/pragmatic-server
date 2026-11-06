import { strict as assert } from 'node:assert'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import type { IEnvironmentService } from '../control-plane-host.js'
import { EmailDomainPolicy } from '../email-domain-policy.js'
import type { TenantRecord } from '../platform-records.js'
import { SeededTenantDirectory } from '../tenant-api/seeded-tenant-directory.js'
import { TenantApiEndpoint } from '../tenant-api/tenant-api-endpoint.js'
import { DomainNotClaimedError, DomainVerificationUnavailableError, DomainVerifyThrottledError, EmailDomainsNotEditableError, type ITenantEmailDomains, type TenantEmailDomainsView } from '../tenant-api/tenant-email-domains.js'
import { DomainApprovalState, type DomainVerificationView } from '../domain-verification-record.js'
import { InvalidEmailDomainError } from '../email-domain-policy.js'
import type { TenantSession } from '../tenant-auth/tenant-session.js'
import { ResRecorder } from './res-recorder.js'

/** An in-memory store: editable unless told otherwise; records the tenant ids it was asked about. */
class FakeEmailDomains implements ITenantEmailDomains
{
    public domains: string[] = ['acme.test']
    public pending: string[] = []
    public readonly Asked: string[] = []
    public readonly VerifiedDomains: string[] = []
    public verifications: DomainVerificationView[] = []
    public VerifyError: Error | undefined

    public constructor(private readonly editable: boolean = true, private readonly inHive: boolean = false)
    {
    }

    public async For(tenantId: string): Promise<TenantEmailDomainsView>
    {
        this.Asked.push(tenantId)
        return { domains: [...this.domains], editable: this.editable, inHive: this.inHive, pending: [...this.pending], verifications: [...this.verifications] }
    }

    public async Verify(tenantId: string, domain: string): Promise<TenantEmailDomainsView>
    {
        this.Asked.push(tenantId)
        this.VerifiedDomains.push(domain)
        if (this.VerifyError !== undefined)
        {
            throw this.VerifyError
        }
        return await this.For(tenantId)
    }

    public async Set(tenantId: string, domains: unknown): Promise<TenantEmailDomainsView>
    {
        this.Asked.push(tenantId)
        if (!this.editable)
        {
            throw new EmailDomainsNotEditableError('This tenant\'s console runs in its hive; its email domains are set there by the tenant Owner.')
        }
        this.domains = EmailDomainPolicy.Parse(domains)
        return await this.For(tenantId)
    }
}

class Fixtures
{
    public static readonly TenantId = 't-a'
    public static readonly OwnerId = 'owner-1'
    public static readonly Path = '/tenant-api/settings/email-domains'
    public static readonly VerifyPath = '/tenant-api/settings/email-domains/verify'

    public static Build(store: ITenantEmailDomains | undefined): TenantApiEndpoint
    {
        const tenant: TenantRecord = { id: Fixtures.TenantId, clientId: 'c', displayName: 'A', createdAt: '2026-01-01T00:00:00Z', ownerPrincipalId: Fixtures.OwnerId }
        const directory = new SeededTenantDirectory({ tenant, hives: [] })
        return new TenantApiEndpoint({} as IEnvironmentService, directory, undefined as never, undefined as never, undefined as never, store)
    }

    public static Session(principalId: string): TenantSession
    {
        return { id: 'sess', tenantId: Fixtures.TenantId, principalId, expiresAt: '2099-01-01T00:00:00Z' }
    }

    public static Req(method: string, body?: unknown): IncomingMessage
    {
        const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
        const stream = Readable.from(text.length === 0 ? [] : [Buffer.from(text)]) as unknown as IncomingMessage & { method?: string; headers?: Record<string, string> }
        stream.method = method
        stream.headers = { 'content-length': String(Buffer.byteLength(text)) }
        return stream
    }

    public static async Send(endpoint: TenantApiEndpoint, principalId: string, method: string, body?: unknown, path: string = Fixtures.Path): Promise<{ status: number; json: Record<string, unknown> }>
    {
        const res = new ResRecorder()
        assert.equal(await endpoint.Handle(Fixtures.Req(method, body), res as unknown as ServerResponse, path, Fixtures.Session(principalId)), true)
        return { status: res.status, json: JSON.parse(res.body) as Record<string, unknown> }
    }

    /** 20 distinct long (but valid) domains: a valid list that is larger than 4 KiB. */
    public static LongDomains(): string[]
    {
        return Array.from({ length: 20 }, (_, i) => ['a', 'b', 'c', 'e'].map(c => c.repeat(60)).join('.') + '.d' + String(i) + '.test')
    }
}

describe('TenantApiEndpoint email domains', () =>
{
    it('the Owner reads and sets the domains', async () =>
    {
        const store = new FakeEmailDomains()
        const endpoint = Fixtures.Build(store)
        assert.deepEqual(await Fixtures.Send(endpoint, Fixtures.OwnerId, 'GET'), { status: 200, json: { domains: ['acme.test'], editable: true, inHive: false, pending: [], verifications: [] } })
        assert.deepEqual(await Fixtures.Send(endpoint, Fixtures.OwnerId, 'PUT', { domains: ['Acme.test'] }), { status: 200, json: { domains: ['acme.test'], editable: true, inHive: false, pending: [], verifications: [] } })
        assert.ok(store.Asked.every(id => id === Fixtures.TenantId))
    })

    it('passes the store\'s inHive flag through on GET and PUT', async () =>
    {
        const endpoint = Fixtures.Build(new FakeEmailDomains(true, true))
        assert.deepEqual(await Fixtures.Send(endpoint, Fixtures.OwnerId, 'GET'), { status: 200, json: { domains: ['acme.test'], editable: true, inHive: true, pending: [], verifications: [] } })
        assert.deepEqual(await Fixtures.Send(endpoint, Fixtures.OwnerId, 'PUT', { domains: ['acme.test'] }), { status: 200, json: { domains: ['acme.test'], editable: true, inHive: true, pending: [], verifications: [] } })
    })

    it('passes the store\'s pending domains through on GET and PUT', async () =>
    {
        const store = new FakeEmailDomains()
        store.pending = ['acme.test']
        const endpoint = Fixtures.Build(store)
        assert.deepEqual((await Fixtures.Send(endpoint, Fixtures.OwnerId, 'GET')).json.pending, ['acme.test'])
        assert.deepEqual((await Fixtures.Send(endpoint, Fixtures.OwnerId, 'PUT', { domains: ['acme.test'] })).json.pending, ['acme.test'])
        assert.deepEqual((await Fixtures.Send(endpoint, 'someone-else', 'GET')).json.pending, ['acme.test'])
    })

    it('a non-Owner reads them as not editable and gets 403 on PUT', async () =>
    {
        const store = new FakeEmailDomains()
        const endpoint = Fixtures.Build(store)
        assert.deepEqual(await Fixtures.Send(endpoint, 'someone-else', 'GET'), { status: 200, json: { domains: ['acme.test'], editable: false, inHive: false, pending: [], verifications: [] } })
        assert.deepEqual(await Fixtures.Send(endpoint, 'someone-else', 'PUT', { domains: ['other.test'] }), { status: 403, json: { error: 'forbidden' } })
        assert.deepEqual(store.domains, ['acme.test'])
    })

    it('a public mail domain is 400 with the sentence', async () =>
    {
        const r = await Fixtures.Send(Fixtures.Build(new FakeEmailDomains()), Fixtures.OwnerId, 'PUT', { domains: ['gmail.com'] })
        assert.equal(r.status, 400)
        assert.equal(r.json.error, 'gmail.com is a public mail domain: anyone can have an address there, so it cannot point to one tenant.')
    })

    it('a not-editable store is 409', async () =>
    {
        const r = await Fixtures.Send(Fixtures.Build(new FakeEmailDomains(false)), Fixtures.OwnerId, 'PUT', { domains: ['acme.test'] })
        assert.equal(r.status, 409)
        assert.equal(r.json.error, "This tenant's console runs in its hive; its email domains are set there by the tenant Owner.")
    })

    it('a not-editable store reads as not editable even for the Owner', async () =>
    {
        assert.deepEqual(await Fixtures.Send(Fixtures.Build(new FakeEmailDomains(false)), Fixtures.OwnerId, 'GET'), { status: 200, json: { domains: ['acme.test'], editable: false, inHive: false, pending: [], verifications: [] } })
    })

    it('a body without domains is 400', async () =>
    {
        const endpoint = Fixtures.Build(new FakeEmailDomains())
        for (const body of [{}, ['acme.test'], 'null', '{nope'])
        {
            const r = await Fixtures.Send(endpoint, Fixtures.OwnerId, 'PUT', body)
            assert.equal(r.status, 400)
            assert.equal(typeof r.json.error, 'string')
        }
        assert.deepEqual((await Fixtures.Send(endpoint, Fixtures.OwnerId, 'PUT', {})).json, { error: 'domains (array of domain names) is required' })
    })

    it('a list of 20 long domains fits the 16 KiB body cap', async () =>
    {
        const domains = Fixtures.LongDomains()
        assert.ok(Buffer.byteLength(JSON.stringify({ domains })) > 4096)
        const r = await Fixtures.Send(Fixtures.Build(new FakeEmailDomains()), Fixtures.OwnerId, 'PUT', { domains })
        assert.equal(r.status, 200)
        assert.equal((r.json.domains as string[]).length, 20)
    })

    it('without an email-domain store the paths are not routes', async () =>
    {
        const endpoint = Fixtures.Build(undefined)
        assert.equal((await Fixtures.Send(endpoint, Fixtures.OwnerId, 'GET')).status, 404)
        assert.equal((await Fixtures.Send(endpoint, Fixtures.OwnerId, 'PUT', { domains: [] })).status, 404)
        assert.equal((await Fixtures.Send(endpoint, Fixtures.OwnerId, 'POST', { domain: 'acme.test' }, Fixtures.VerifyPath)).status, 404)
    })

    it('the Owner verifies a domain and gets the view with verifications', async () =>
    {
        const store = new FakeEmailDomains()
        store.verifications = [{
            domain: 'acme.test', token: 'A'.repeat(43), verified: true, state: DomainApprovalState.Verified,
            recordName: '_pragmatic-verification.acme.test', recordValue: 'pragmatic-domain-verification=' + 'A'.repeat(43),
        }]
        const r = await Fixtures.Send(Fixtures.Build(store), Fixtures.OwnerId, 'POST', { domain: 'acme.test' }, Fixtures.VerifyPath)
        assert.deepEqual(r, { status: 200, json: { domains: ['acme.test'], editable: true, inHive: false, pending: [], verifications: store.verifications } })
        assert.deepEqual(store.VerifiedDomains, ['acme.test'])
    })

    it('a non-Owner gets 403 and the store is not called', async () =>
    {
        const store = new FakeEmailDomains()
        const r = await Fixtures.Send(Fixtures.Build(store), 'someone-else', 'POST', { domain: 'acme.test' }, Fixtures.VerifyPath)
        assert.deepEqual(r, { status: 403, json: { error: 'forbidden' } })
        assert.deepEqual(store.Asked, [])
        assert.deepEqual(store.VerifiedDomains, [])
    })

    it('the session\'s tenant id is passed, never one from the body', async () =>
    {
        const store = new FakeEmailDomains()
        await Fixtures.Send(Fixtures.Build(store), Fixtures.OwnerId, 'POST', { domain: 'acme.test', tenantId: 'other' }, Fixtures.VerifyPath)
        assert.deepEqual(store.Asked, [Fixtures.TenantId, Fixtures.TenantId])
    })

    it('a missing or non-string domain, or bad JSON, is 400', async () =>
    {
        const store = new FakeEmailDomains()
        const endpoint = Fixtures.Build(store)
        for (const body of [{}, { domain: 5 }, { domain: null }, ['acme.test'], 'null', '{nope'])
        {
            const r = await Fixtures.Send(endpoint, Fixtures.OwnerId, 'POST', body, Fixtures.VerifyPath)
            assert.equal(r.status, 400)
            assert.equal(typeof r.json.error, 'string')
        }
        assert.deepEqual((await Fixtures.Send(endpoint, Fixtures.OwnerId, 'POST', {}, Fixtures.VerifyPath)).json, { error: 'domain (an email domain name) is required' })
        assert.deepEqual(store.VerifiedDomains, [])
    })

    it('each store error maps to its status with its sentence (400, 409, 429, 503)', async () =>
    {
        const cases: Array<[Error, number]> = [
            [new InvalidEmailDomainError('not a domain.'), 400],
            [new DomainNotClaimedError('acme.test is not one of your email domains.'), 409],
            [new EmailDomainsNotEditableError('set in the hive.'), 409],
            [new DomainVerifyThrottledError('Too many checks; try again later.'), 429],
            [new DomainVerificationUnavailableError('DNS did not answer.'), 503],
        ]
        for (const [error, status] of cases)
        {
            const store = new FakeEmailDomains()
            store.VerifyError = error
            const r = await Fixtures.Send(Fixtures.Build(store), Fixtures.OwnerId, 'POST', { domain: 'acme.test' }, Fixtures.VerifyPath)
            assert.deepEqual(r, { status, json: { error: error.message } })
        }
    })

    it('an unexpected store error is not swallowed', async () =>
    {
        const store = new FakeEmailDomains()
        store.VerifyError = new Error('boom')
        await assert.rejects(Fixtures.Send(Fixtures.Build(store), Fixtures.OwnerId, 'POST', { domain: 'acme.test' }, Fixtures.VerifyPath), /boom/)
    })

    it('verify accepts only POST', async () =>
    {
        const endpoint = Fixtures.Build(new FakeEmailDomains())
        assert.equal((await Fixtures.Send(endpoint, Fixtures.OwnerId, 'GET', undefined, Fixtures.VerifyPath)).status, 404)
        assert.equal((await Fixtures.Send(endpoint, Fixtures.OwnerId, 'PUT', { domain: 'acme.test' }, Fixtures.VerifyPath)).status, 404)
    })

    it('GET passes verifications through', async () =>
    {
        const store = new FakeEmailDomains()
        store.verifications = [{
            domain: 'acme.test', token: 'B'.repeat(43), verified: false, state: DomainApprovalState.Pending,
            recordName: '_pragmatic-verification.acme.test', recordValue: 'pragmatic-domain-verification=' + 'B'.repeat(43),
        }]
        assert.deepEqual((await Fixtures.Send(Fixtures.Build(store), 'someone-else', 'GET')).json.verifications, store.verifications)
    })
})
