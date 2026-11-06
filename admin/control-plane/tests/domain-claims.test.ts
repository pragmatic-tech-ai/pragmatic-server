import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConsoleAdvertRecord, IConsoleAdvertLookup } from '../console-advert-registry.js'
import { DomainClaims, type IDomainClaimDirectory } from '../domain-claims.js'
import { IngressTlsSource } from '../ingress-tls.js'
import { HiveBackend, InfraMode, type HiveRecord, type TenantRecord } from '../platform-records.js'

/** A directory held in memory: tenants and their hives, editable between Collect calls. */
class FakeDirectory implements IDomainClaimDirectory
{
    public readonly tenants: TenantRecord[] = []
    public readonly hives: HiveRecord[] = []

    public AddTenant(id: string, emailDomains?: string[]): FakeDirectory
    {
        const tenant: TenantRecord = { id, clientId: 'c1', displayName: id, createdAt: '2026-11-06T00:00:00.000Z' }
        this.tenants.push(emailDomains === undefined ? tenant : { ...tenant, emailDomains })
        return this
    }

    public AddConsoleHive(tenantId: string, hiveId: string): FakeDirectory
    {
        this.hives.push({
            id: hiveId, tenantId, displayName: hiveId, createdAt: '2026-11-06T00:00:00.000Z',
            cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision },
            console: { baseDomain: 'localtest.me', tls: { source: IngressTlsSource.Development } },
        } as HiveRecord)
        return this
    }

    public SetDomains(tenantId: string, emailDomains: string[]): void
    {
        const index = this.tenants.findIndex(t => t.id === tenantId)
        this.tenants[index] = { ...this.tenants[index], emailDomains }
    }

    public ListTenants(): readonly TenantRecord[]
    {
        return this.tenants
    }

    public ListHives(tenantId: string): readonly HiveRecord[]
    {
        return this.hives.filter(h => h.tenantId === tenantId)
    }
}

/** Adverts held in memory, keyed by tenant. */
class FakeAdverts implements IConsoleAdvertLookup
{
    private readonly adverts = new Map<string, ConsoleAdvertRecord>()

    public Advertise(tenantId: string, hiveId: string, emailDomains: string[]): FakeAdverts
    {
        this.adverts.set(tenantId, {
            id: tenantId, tenantId, hiveId, consoleUrl: 'https://console-' + tenantId + '.localtest.me', fingerprints: [], emailDomains,
            firstReportedAt: '2026-11-06T00:00:00.000Z', reportedAt: '2026-11-06T00:00:00.000Z',
        })
        return this
    }

    public ForTenant(tenantId: string): ConsoleAdvertRecord | undefined
    {
        return this.adverts.get(tenantId)
    }

    public All(): readonly Readonly<ConsoleAdvertRecord>[]
    {
        return [...this.adverts.values()]
    }

    public HasFingerprint(): boolean
    {
        return false
    }
}

test('a control-plane tenant claims its record domains, normalised', () =>
{
    const directory = new FakeDirectory().AddTenant('acme', [' Acme.TEST.', 'b.test', 'acme.test']).AddTenant('bare')
    const claims = DomainClaims.Collect(directory, undefined)
    assert.deepEqual(claims.ClaimedBy('acme'), ['acme.test', 'b.test'])
    assert.deepEqual(claims.ClaimedBy('bare'), [])
    assert.deepEqual(claims.ClaimedBy('unknown'), [])
})

test('an in-hive tenant claims its usable advert domains and not its record domains', () =>
{
    const directory = new FakeDirectory().AddTenant('acme', ['record.test']).AddConsoleHive('acme', 'acme-hive')
    const adverts = new FakeAdverts().Advertise('acme', 'acme-hive', ['Advert.TEST', 'eu.advert.test'])
    assert.deepEqual(DomainClaims.Collect(directory, adverts).ClaimedBy('acme'), ['advert.test', 'eu.advert.test'])

    assert.deepEqual(DomainClaims.Collect(directory, undefined).ClaimedBy('acme'), [])
    const stale = new FakeAdverts().Advertise('acme', 'gone-hive', ['advert.test'])
    assert.deepEqual(DomainClaims.Collect(directory, stale).ClaimedBy('acme'), [])
})

test('OthersClaiming and ContestedFor see the other tenants\' claims', () =>
{
    const directory = new FakeDirectory()
        .AddTenant('acme', ['acme.test', 'shared.test', 'own.test'])
        .AddTenant('zeta', ['shared.test', 'acme.test'])
        .AddTenant('beta', ['Shared.TEST'])
        .AddTenant('hive', ['acme.test']).AddConsoleHive('hive', 'h1')
    const adverts = new FakeAdverts().Advertise('hive', 'h1', ['shared.test'])
    const claims = DomainClaims.Collect(directory, adverts)
    assert.deepEqual(claims.OthersClaiming('acme', 'shared.test'), ['beta', 'hive', 'zeta'])
    assert.deepEqual(claims.OthersClaiming('acme', ' ACME.test.'), ['zeta'])
    assert.deepEqual(claims.OthersClaiming('acme', 'own.test'), [])
    assert.deepEqual([...claims.ContestedFor('acme')].sort(), ['acme.test', 'shared.test'])
    assert.deepEqual([...claims.ContestedFor('beta')], ['shared.test'])
    assert.deepEqual([...claims.ContestedFor('unknown')], [])
})

test('a domain stops being contested once the other tenant drops it', () =>
{
    const directory = new FakeDirectory().AddTenant('acme', ['acme.test']).AddTenant('zeta', ['acme.test'])
    assert.deepEqual([...DomainClaims.Collect(directory, undefined).ContestedFor('acme')], ['acme.test'])
    directory.SetDomains('zeta', ['zeta.test'])
    const claims = DomainClaims.Collect(directory, undefined)
    assert.deepEqual([...claims.ContestedFor('acme')], [])
    assert.deepEqual(claims.OthersClaiming('acme', 'acme.test'), [])
})
