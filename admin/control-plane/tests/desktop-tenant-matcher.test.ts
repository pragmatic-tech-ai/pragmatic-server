import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConsoleFingerprint } from '../console-advert-contract.js'
import type { ConsoleAdvertRecord, IConsoleAdvertLookup } from '../console-advert-registry.js'
import { DesktopTenantMatcher, DiscoveryMatch } from '../desktop-tenant-matcher.js'
import type { IDiscoveryDirectory, IDomainApprovalSource, IFingerprintKeySource } from '../desktop-tenant-matcher.js'
import { IngressTlsSource } from '../ingress-tls.js'
import { HiveBackend, InfraMode } from '../platform-records.js'
import type { HiveRecord, TenantRecord } from '../platform-records.js'
import { SealedSecretUnreadableError } from '../sealed-secret-store.js'
import { TenantAccountIndex } from '../tenant-account-index.js'

class MatcherDirectory implements IDiscoveryDirectory
{
    public readonly Tenants = new Map<string, TenantRecord>()
    public readonly Hives = new Map<string, HiveRecord>()

    public GetTenant(id: string): TenantRecord | undefined
    {
        return this.Tenants.get(id)
    }

    public GetHive(id: string): HiveRecord | undefined
    {
        return this.Hives.get(id)
    }

    public ListHives(tenantId: string): readonly HiveRecord[]
    {
        return [...this.Hives.values()].filter(h => h.tenantId === tenantId)
    }

    public ListTenants(): readonly TenantRecord[]
    {
        return [...this.Tenants.values()]
    }
}

class MatcherAdverts implements IConsoleAdvertLookup
{
    public readonly Records = new Map<string, ConsoleAdvertRecord>()

    public ForTenant(tenantId: string): ConsoleAdvertRecord | undefined
    {
        return this.Records.get(tenantId)
    }

    public All(): readonly Readonly<ConsoleAdvertRecord>[]
    {
        return [...this.Records.values()]
    }

    public HasFingerprint(tenantId: string, fingerprint: string): boolean
    {
        return this.Records.get(tenantId)?.fingerprints.includes(fingerprint) ?? false
    }
}

class MatcherKeys implements IFingerprintKeySource
{
    public readonly Keys = new Map<string, Buffer>()
    public readonly Unreadable = new Set<string>()

    public async Get(hiveId: string): Promise<Buffer | undefined>
    {
        if (this.Unreadable.has(hiveId))
        {
            throw new SealedSecretUnreadableError()
        }
        return this.Keys.get(hiveId)
    }
}

class MatcherApprovals implements IDomainApprovalSource
{
    public readonly Approved = new Map<string, string[]>()

    public ApprovedFor(tenantId: string): readonly string[]
    {
        return this.Approved.get(tenantId) ?? []
    }
}

class MatcherFixture
{
    public static readonly Plane = 'http://127.0.0.1:7002'
    public static readonly Console = 'https://console-acme.localtest.me'
    public static readonly Ann = 'ann@acme.test'
    public static readonly Key = Buffer.alloc(32, 7)

    public static Tenant(id: string, displayName: string, emailDomains?: string[]): TenantRecord
    {
        return { id, clientId: 'c1', displayName, createdAt: '2026-01-01T00:00:00.000Z', emailDomains }
    }

    public static Hive(id: string, tenantId: string, withConsole: boolean): HiveRecord
    {
        return {
            id, tenantId, displayName: id, createdAt: '2026-01-01T00:00:00.000Z',
            cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach },
            registry: { mode: InfraMode.Attach },
            console: withConsole ? { baseDomain: 'localtest.me', tls: { source: IngressTlsSource.Development } } : undefined
        }
    }

    public static Advert(over: Partial<ConsoleAdvertRecord> = {}): ConsoleAdvertRecord
    {
        return {
            id: 'acme', tenantId: 'acme', hiveId: 'h1', consoleUrl: MatcherFixture.Console, fingerprints: [], emailDomains: [],
            firstReportedAt: '2026-11-04T10:00:00.000Z', reportedAt: '2026-11-04T10:00:00.000Z', ...over
        }
    }
}

describe('DesktopTenantMatcher', () =>
{
    let dir: string
    let index: TenantAccountIndex
    let directory: MatcherDirectory
    let adverts: MatcherAdverts
    let keys: MatcherKeys
    let approvals: MatcherApprovals
    let matcher: DesktopTenantMatcher

    beforeEach(async () =>
    {
        dir = await mkdtemp(join(tmpdir(), 'tenant-matcher-'))
        index = new TenantAccountIndex(join(dir, 'tenant-accounts.json'))
        await index.Load()
        directory = new MatcherDirectory()
        adverts = new MatcherAdverts()
        keys = new MatcherKeys()
        approvals = new MatcherApprovals()
        directory.Tenants.set('acme', MatcherFixture.Tenant('acme', 'Acme'))
        directory.Hives.set('h1', MatcherFixture.Hive('h1', 'acme', true))
        keys.Keys.set('h1', MatcherFixture.Key)
        matcher = new DesktopTenantMatcher(index, directory, adverts, keys, approvals)
    })

    afterEach(async () =>
    {
        await rm(dir, { recursive: true, force: true })
    })

    function Summary(found: Awaited<ReturnType<DesktopTenantMatcher['Match']>>): { id: string; consoleUrl: string; match: DiscoveryMatch }[]
    {
        return found.map(d => ({ id: d.tenant.id, consoleUrl: d.consoleUrl, match: d.match }))
    }

    it('a control-plane tenant found by the index points at the tenant plane', async () =>
    {
        directory.Tenants.set('beta', MatcherFixture.Tenant('beta', 'Beta'))
        await index.Record('beta', 'owner', 'bob@beta.test')
        assert.deepEqual(Summary(await matcher.Match('bob@beta.test', MatcherFixture.Plane)), [{ id: 'beta', consoleUrl: MatcherFixture.Plane, match: DiscoveryMatch.Account }])
    })

    it('an in-hive tenant is left out until its first advert', async () =>
    {
        await index.Record('acme', 'owner', MatcherFixture.Ann)
        assert.deepEqual(await matcher.Match(MatcherFixture.Ann, MatcherFixture.Plane), [])
    })

    it('an advert fingerprint match points at the advertised console', async () =>
    {
        adverts.Records.set('acme', MatcherFixture.Advert({ fingerprints: [ConsoleFingerprint.Of(MatcherFixture.Key, MatcherFixture.Ann)] }))
        assert.deepEqual(Summary(await matcher.Match('  Ann@Acme.TEST ', MatcherFixture.Plane)), [{ id: 'acme', consoleUrl: MatcherFixture.Console, match: DiscoveryMatch.Account }])
    })

    it('an index match of an in-hive tenant with an advert uses the advertised console', async () =>
    {
        await index.Record('acme', 'owner', MatcherFixture.Ann)
        adverts.Records.set('acme', MatcherFixture.Advert())
        assert.deepEqual(Summary(await matcher.Match(MatcherFixture.Ann, MatcherFixture.Plane)), [{ id: 'acme', consoleUrl: MatcherFixture.Console, match: DiscoveryMatch.Account }])
    })

    it('a domain on a control-plane tenant record matches; the same domain on an in-hive record does not', async () =>
    {
        directory.Tenants.set('acme', MatcherFixture.Tenant('acme', 'Acme', ['acme.test']))
        adverts.Records.set('acme', MatcherFixture.Advert())
        directory.Tenants.set('beta', MatcherFixture.Tenant('beta', 'Beta', ['acme.test']))
        assert.deepEqual(Summary(await matcher.Match(' CARL@Acme.Test  ', MatcherFixture.Plane)), [{ id: 'beta', consoleUrl: MatcherFixture.Plane, match: DiscoveryMatch.Domain }])
    })

    it('an advert domain matches an in-hive tenant', async () =>
    {
        adverts.Records.set('acme', MatcherFixture.Advert({ emailDomains: ['acme.test'] }))
        approvals.Approved.set('acme', ['acme.test'])
        assert.deepEqual(Summary(await matcher.Match('  Carl@ACME.test ', MatcherFixture.Plane)), [{ id: 'acme', consoleUrl: MatcherFixture.Console, match: DiscoveryMatch.Domain }])
    })

    it('an advertised domain the operator has not approved does not match', async () =>
    {
        adverts.Records.set('acme', MatcherFixture.Advert({ emailDomains: ['acme.test', 'other.test'] }))
        approvals.Approved.set('acme', ['acme.test'])
        assert.deepEqual(await matcher.Match('carl@other.test', MatcherFixture.Plane), [])
    })

    it('an approved domain the advert no longer claims does not match', async () =>
    {
        adverts.Records.set('acme', MatcherFixture.Advert({ emailDomains: [] }))
        approvals.Approved.set('acme', ['acme.test'])
        assert.deepEqual(await matcher.Match('carl@acme.test', MatcherFixture.Plane), [])
    })

    it('without an approval source no advertised domain matches', async () =>
    {
        adverts.Records.set('acme', MatcherFixture.Advert({ emailDomains: ['acme.test'] }))
        const bare = new DesktopTenantMatcher(index, directory, adverts, keys)
        assert.deepEqual(await bare.Match('carl@acme.test', MatcherFixture.Plane), [])
    })

    it('a tenant matched by fingerprint and domain appears once, as an account match', async () =>
    {
        adverts.Records.set('acme', MatcherFixture.Advert({ fingerprints: [ConsoleFingerprint.Of(MatcherFixture.Key, MatcherFixture.Ann)], emailDomains: ['acme.test'] }))
        approvals.Approved.set('acme', ['acme.test'])
        await index.Record('acme', 'owner', MatcherFixture.Ann)
        assert.deepEqual(Summary(await matcher.Match(MatcherFixture.Ann, MatcherFixture.Plane)), [{ id: 'acme', consoleUrl: MatcherFixture.Console, match: DiscoveryMatch.Account }])
    })

    it('two tenants claiming one domain are both returned', async () =>
    {
        adverts.Records.set('acme', MatcherFixture.Advert({ emailDomains: ['acme.test'] }))
        approvals.Approved.set('acme', ['acme.test'])
        directory.Tenants.set('beta', MatcherFixture.Tenant('beta', 'Beta', ['acme.test']))
        assert.deepEqual(Summary(await matcher.Match('carl@acme.test', MatcherFixture.Plane)), [
            { id: 'acme', consoleUrl: MatcherFixture.Console, match: DiscoveryMatch.Domain },
            { id: 'beta', consoleUrl: MatcherFixture.Plane, match: DiscoveryMatch.Domain }
        ])
    })

    it('orders account matches before domain matches, then by display name', async () =>
    {
        directory.Tenants.set('zed', MatcherFixture.Tenant('zed', 'Aardvark', ['acme.test']))
        directory.Tenants.set('yak', MatcherFixture.Tenant('yak', 'Zebra'))
        directory.Tenants.set('xen', MatcherFixture.Tenant('xen', 'Yeti'))
        await index.Record('yak', 'owner', MatcherFixture.Ann)
        await index.Record('xen', 'owner', MatcherFixture.Ann)
        assert.deepEqual(Summary(await matcher.Match(MatcherFixture.Ann, MatcherFixture.Plane)).map(s => s.id), ['xen', 'yak', 'zed'])
    })

    it('a subdomain does not match its parent domain', async () =>
    {
        adverts.Records.set('acme', MatcherFixture.Advert({ emailDomains: ['acme.test'] }))
        approvals.Approved.set('acme', ['acme.test'])
        directory.Tenants.set('beta', MatcherFixture.Tenant('beta', 'Beta', ['acme.test']))
        assert.deepEqual(await matcher.Match('a@eu.acme.test', MatcherFixture.Plane), [])
    })

    it('an advert whose hive no longer runs the console is ignored', async () =>
    {
        adverts.Records.set('acme', MatcherFixture.Advert({ fingerprints: [ConsoleFingerprint.Of(MatcherFixture.Key, MatcherFixture.Ann)], emailDomains: ['acme.test'] }))
        approvals.Approved.set('acme', ['acme.test'])
        directory.Hives.set('h1', MatcherFixture.Hive('h1', 'acme', false))
        assert.deepEqual(await matcher.Match(MatcherFixture.Ann, MatcherFixture.Plane), [])
        await index.Record('acme', 'owner', MatcherFixture.Ann)
        assert.deepEqual(Summary(await matcher.Match(MatcherFixture.Ann, MatcherFixture.Plane)), [{ id: 'acme', consoleUrl: MatcherFixture.Plane, match: DiscoveryMatch.Account }])
    })

    it('an advert from a hive other than the console hive is ignored', async () =>
    {
        directory.Hives.set('h2', MatcherFixture.Hive('h2', 'acme', false))
        adverts.Records.set('acme', MatcherFixture.Advert({ hiveId: 'h2', fingerprints: [ConsoleFingerprint.Of(MatcherFixture.Key, MatcherFixture.Ann)] }))
        keys.Keys.set('h2', MatcherFixture.Key)
        await index.Record('acme', 'owner', MatcherFixture.Ann)
        assert.deepEqual(await matcher.Match(MatcherFixture.Ann, MatcherFixture.Plane), [])
    })

    it('a stale advert is still used', async () =>
    {
        adverts.Records.set('acme', MatcherFixture.Advert({ reportedAt: '2020-01-01T00:00:00.000Z', fingerprints: [ConsoleFingerprint.Of(MatcherFixture.Key, MatcherFixture.Ann)] }))
        assert.deepEqual(Summary(await matcher.Match(MatcherFixture.Ann, MatcherFixture.Plane)), [{ id: 'acme', consoleUrl: MatcherFixture.Console, match: DiscoveryMatch.Account }])
    })

    it('a missing fingerprint key skips that advert\'s fingerprints but not its domains', async () =>
    {
        adverts.Records.set('acme', MatcherFixture.Advert({ fingerprints: [ConsoleFingerprint.Of(MatcherFixture.Key, MatcherFixture.Ann)], emailDomains: ['acme.test'] }))
        keys.Keys.delete('h1')
        assert.deepEqual(await matcher.Match(MatcherFixture.Ann, MatcherFixture.Plane), [], 'no domain approved yet')
        approvals.Approved.set('acme', ['acme.test'])
        assert.deepEqual(Summary(await matcher.Match(MatcherFixture.Ann, MatcherFixture.Plane)), [{ id: 'acme', consoleUrl: MatcherFixture.Console, match: DiscoveryMatch.Domain }])
    })

    it('an unreadable fingerprint key skips that advert\'s fingerprints but not its domains', async () =>
    {
        adverts.Records.set('acme', MatcherFixture.Advert({ fingerprints: [ConsoleFingerprint.Of(MatcherFixture.Key, MatcherFixture.Ann)], emailDomains: ['acme.test'] }))
        approvals.Approved.set('acme', ['acme.test'])
        keys.Unreadable.add('h1')
        const warn = mock.method(console, 'warn', () => undefined)
        try
        {
            assert.deepEqual(Summary(await matcher.Match(MatcherFixture.Ann, MatcherFixture.Plane)), [{ id: 'acme', consoleUrl: MatcherFixture.Console, match: DiscoveryMatch.Domain }])
        }
        finally
        {
            warn.mock.restore()
        }
    })

    it('an unreadable fingerprint key is logged once per hive, with the hive id and error name only', async () =>
    {
        adverts.Records.set('acme', MatcherFixture.Advert({ fingerprints: [ConsoleFingerprint.Of(MatcherFixture.Key, MatcherFixture.Ann)] }))
        keys.Unreadable.add('h1')
        const warn = mock.method(console, 'warn', () => undefined)
        try
        {
            await matcher.Match(MatcherFixture.Ann, MatcherFixture.Plane)
            await matcher.Match(MatcherFixture.Ann, MatcherFixture.Plane)
            assert.equal(warn.mock.callCount(), 1)
            const line = warn.mock.calls[0].arguments.map(a => String(a)).join(' ')
            assert.match(line, /h1/)
            assert.match(line, /SealedSecretUnreadableError/)
            assert.ok(!line.includes(MatcherFixture.Key.toString('hex')), 'no key material')
            assert.ok(!line.includes(MatcherFixture.Key.toString('base64')), 'no key material')
            assert.ok(!line.toLowerCase().includes(MatcherFixture.Ann), 'no email')
        }
        finally
        {
            warn.mock.restore()
        }
    })

    it('without adverts or keys an in-hive tenant is never matched', async () =>
    {
        await index.Record('acme', 'owner', MatcherFixture.Ann)
        const bare = new DesktopTenantMatcher(index, directory)
        assert.deepEqual(await bare.Match(MatcherFixture.Ann, MatcherFixture.Plane), [])
    })

    it('drops index ids the directory does not know', async () =>
    {
        await index.Record('gone', 'owner', MatcherFixture.Ann)
        assert.deepEqual(await matcher.Match(MatcherFixture.Ann, MatcherFixture.Plane), [])
    })
})
