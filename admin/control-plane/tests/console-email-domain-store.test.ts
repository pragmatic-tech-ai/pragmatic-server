import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConsoleEmailDomainStore } from '../console-email-domain-store.js'
import { InvalidEmailDomainError } from '../email-domain-policy.js'
import { EmailDomainsNotEditableError } from '../tenant-api/tenant-email-domains.js'

class Names
{
    public static readonly TempPrefix = 'console-email-domains-'
    public static readonly TenantId = 'acme'
    public static readonly OtherTenantId = 'other'
    public static readonly SeedDomain = 'acme.test'
    public static readonly NewDomain = 'acme-corp.test'
    public static readonly SecondDomain = 'second.test'
    public static readonly PublicMail = 'gmail.com'
    public static readonly Utf8 = 'utf8'
}

describe('ConsoleEmailDomainStore', () =>
{
    let root = ''
    let file = ''

    beforeEach(() =>
    {
        root = mkdtempSync(join(tmpdir(), Names.TempPrefix))
        file = join(root, ConsoleEmailDomainStore.FileName)
    })

    afterEach(() =>
    {
        rmSync(root, { recursive: true, force: true })
    })

    it('opens with the seed domains when no file exists, without writing', async () =>
    {
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [' ACME.test. ', Names.PublicMail])
        assert.deepEqual(store.Domains, [Names.SeedDomain], 'normalised, the refused seed entry dropped')
        assert.deepEqual(store.For(Names.TenantId), { domains: [Names.SeedDomain], editable: true, inHive: true, pending: [] })
        assert.equal(existsSync(file), false)
        assert.deepEqual(readdirSync(root), [])
    })

    it('opens empty when there is neither a file nor a seed', async () =>
    {
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, undefined)
        assert.deepEqual(store.Domains, [])
    })

    it('Set persists, survives reopen and wins over the seed', async () =>
    {
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [Names.SeedDomain])
        const view = await store.Set(Names.TenantId, [Names.NewDomain])
        assert.deepEqual(view, { domains: [Names.NewDomain], editable: true, inHive: true, pending: [] })
        assert.deepEqual(JSON.parse(readFileSync(file, Names.Utf8)), { domains: [Names.NewDomain] })
        const reopened = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [Names.SeedDomain])
        assert.deepEqual(reopened.Domains, [Names.NewDomain])
        assert.deepEqual(readdirSync(root), [ConsoleEmailDomainStore.FileName], 'no temp file is left behind')
    })

    it('Set to an empty list persists the empty list over the seed', async () =>
    {
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [Names.SeedDomain])
        await store.Set(Names.TenantId, [])
        const reopened = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [Names.SeedDomain])
        assert.deepEqual(reopened.Domains, [])
    })

    it('Set emits Changed once and not for an identical list', async () =>
    {
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [Names.SeedDomain])
        const seen: Array<readonly string[]> = []
        store.Changed.subscribe(d => seen.push(d))
        await store.Set(Names.TenantId, [Names.NewDomain])
        await store.Set(Names.TenantId, [Names.NewDomain.toUpperCase()])
        assert.deepEqual(seen, [[Names.NewDomain]])
    })

    it('two concurrent Sets: the last wins, the file is valid JSON, Changed per real change', async () =>
    {
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [Names.SeedDomain])
        const seen: Array<readonly string[]> = []
        store.Changed.subscribe(d => seen.push(d))
        await Promise.all([store.Set(Names.TenantId, [Names.NewDomain]), store.Set(Names.TenantId, [Names.SecondDomain])])
        assert.deepEqual(store.Domains, [Names.SecondDomain])
        assert.deepEqual(JSON.parse(readFileSync(file, Names.Utf8)), { domains: [Names.SecondDomain] })
        assert.deepEqual(seen, [[Names.NewDomain], [Names.SecondDomain]])
        assert.deepEqual(readdirSync(root), [ConsoleEmailDomainStore.FileName])
        await Promise.all([store.Set(Names.TenantId, [Names.SeedDomain]), store.Set(Names.TenantId, [Names.SeedDomain])])
        assert.equal(seen.length, 3, 'the second identical write is not a change')
    })

    it('Set refuses another tenant', async () =>
    {
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [Names.SeedDomain])
        await assert.rejects(() => store.Set(Names.OtherTenantId, [Names.NewDomain]), EmailDomainsNotEditableError)
        assert.deepEqual(store.For(Names.OtherTenantId), { domains: [], editable: false, inHive: true, pending: [] })
        assert.deepEqual(store.Domains, [Names.SeedDomain])
        assert.equal(existsSync(file), false)
    })

    it('Set refuses a public mail domain and changes nothing', async () =>
    {
        const store = await ConsoleEmailDomainStore.Open(file, Names.TenantId, [Names.SeedDomain])
        let changes = 0
        store.Changed.subscribe(() => changes++)
        await assert.rejects(() => store.Set(Names.TenantId, [Names.NewDomain, Names.PublicMail]), InvalidEmailDomainError)
        assert.deepEqual(store.Domains, [Names.SeedDomain])
        assert.equal(changes, 0)
        assert.equal(existsSync(file), false)
    })

    it('a file that is not { domains: string[] } fails the open naming the file', async () =>
    {
        writeFileSync(file, '{"domains": 3}')
        await assert.rejects(() => ConsoleEmailDomainStore.Open(file, Names.TenantId, undefined), new RegExp(ConsoleEmailDomainStore.FileName))
    })
})
