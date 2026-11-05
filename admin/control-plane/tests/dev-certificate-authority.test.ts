import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes } from 'node:fs/promises'
import { createPublicKey, randomBytes, X509Certificate } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SealedSecretStore } from '../sealed-secret-store.js'
import { DevCaHostOutsideDomainError, DevCaKeyMissingError, DevCertificateAuthority } from '../dev-certificate-authority.js'
import { DevCaError } from '../../../src/idp/dev-ca.js'

class CaFixture
{
    public static readonly Prefix = 'devca-'
    public static readonly Domain = 'localtest.me'
    public static readonly Wildcard = '*.localtest.me'
    public static readonly PrivateKeyMarker = 'PRIVATE KEY'
    public static readonly KeySuffix = '.key'
    public static readonly Encoding = 'utf8'
    public static readonly LeafMs = 397 * 24 * 3600 * 1000
    public static readonly WildcardSan = 'DNS:*.localtest.me'
    public static readonly DomainSan = 'DNS:localtest.me'
    public static readonly OutsideHost = 'console.example.com'
    public static readonly SuffixTrick = 'evillocaltest.me'
    public static readonly InnerWildcards = ['a.*.localtest.me', 'x*.localtest.me']
    public static readonly BadHosts = ['-lead.localtest.me', 'trail-.localtest.me', `${'a'.repeat(64)}.localtest.me`]
    public static readonly BadBases = ['me', 'localhost', 'co.uk', 'com.au', '-bad.me', 'bad-.me', `${'a'.repeat(64)}.me`]
    public static readonly MissingOpenssl = 'no-such-openssl-binary'
    public static readonly StagingPrefix = '.dev-ca-staging-'
    public static readonly StaleSeconds = 3600

    public static async With(body: (ca: DevCertificateAuthority, root: string, vaultFile: string, store: SealedSecretStore) => Promise<void>): Promise<void>
    {
        const dir = await mkdtemp(join(tmpdir(), CaFixture.Prefix))
        try
        {
            const vaultFile = join(dir, SealedSecretStore.FileName)
            const store = await SealedSecretStore.Open(vaultFile, randomBytes(32))
            const root = join(dir, DevCertificateAuthority.DirName)
            await body(new DevCertificateAuthority(root, store), root, vaultFile, store)
        }
        finally
        {
            await rm(dir, { recursive: true, force: true })
        }
    }

    public static async Walk(dir: string): Promise<string[]>
    {
        const out: string[] = []
        for (const entry of await readdir(dir, { withFileTypes: true }))
        {
            const full = join(dir, entry.name)
            if (entry.isDirectory())
            {
                out.push(...await CaFixture.Walk(full))
            }
            else
            {
                out.push(full)
            }
        }
        return out
    }
}

test('EnsureCa makes a name-constrained CA once', async () =>
{
    await CaFixture.With(async (ca) =>
    {
        const pem = await ca.EnsureCa(CaFixture.Domain)
        assert.equal(new X509Certificate(pem).ca, true)
        assert.deepEqual(await ca.EnsureCa(CaFixture.Domain), pem)
        const text = execFileSync('openssl', ['x509', '-noout', '-text', '-in', ca.CaFileOf(CaFixture.Domain)], { encoding: CaFixture.Encoding })
        assert.match(text, /Permitted:/)
        assert.match(text, /DNS:localtest\.me/)
    })
})

test('the CA key never stays on disk', async () =>
{
    await CaFixture.With(async (ca, root, vaultFile) =>
    {
        await ca.EnsureCa(CaFixture.Domain)
        await ca.Issue(CaFixture.Domain, [CaFixture.Wildcard])
        for (const file of await CaFixture.Walk(root))
        {
            assert.equal(file.endsWith(CaFixture.KeySuffix), false)
            assert.equal((await readFile(file, CaFixture.Encoding)).includes(CaFixture.PrivateKeyMarker), false)
        }
        assert.equal((await readFile(vaultFile, CaFixture.Encoding)).includes(CaFixture.PrivateKeyMarker), false)
        assert.equal((await readdir(root)).every(n => !n.startsWith('.')), true)
        assert.ok((await stat(ca.CaFileOf(CaFixture.Domain))).isFile())
    })
})

test('Issue signs a wildcard leaf for the base domain', async () =>
{
    await CaFixture.With(async (ca) =>
    {
        const caCert = new X509Certificate(await ca.EnsureCa(CaFixture.Domain))
        const issued = await ca.Issue(CaFixture.Domain, [CaFixture.Wildcard, CaFixture.Domain])
        const leaf = new X509Certificate(issued.cert)
        assert.equal(leaf.checkIssued(caCert), true)
        assert.equal(leaf.verify(caCert.publicKey), true)
        assert.ok(leaf.subjectAltName?.includes(CaFixture.WildcardSan))
        assert.ok(leaf.subjectAltName?.includes(CaFixture.DomainSan))
        assert.equal(new Date(leaf.validTo).getTime() - new Date(leaf.validFrom).getTime(), CaFixture.LeafMs)
        assert.equal(leaf.ca, false)
        const fromKey = createPublicKey(issued.key).export({ type: 'spki', format: 'der' })
        assert.deepEqual(fromKey, leaf.publicKey.export({ type: 'spki', format: 'der' }))
    })
})

test('Issue refuses a host outside the base domain and an inner wildcard', async () =>
{
    await CaFixture.With(async (ca) =>
    {
        for (const host of [CaFixture.OutsideHost, CaFixture.SuffixTrick, ...CaFixture.InnerWildcards, ...CaFixture.BadHosts])
        {
            await assert.rejects(ca.Issue(CaFixture.Domain, [host]), DevCaHostOutsideDomainError)
        }
        await assert.rejects(ca.Issue(CaFixture.Domain, []), DevCaHostOutsideDomainError)
    })
})

test('a CA whose sealed key was lost is not re-minted', async () =>
{
    await CaFixture.With(async (ca, _root, _vaultFile, store) =>
    {
        const before = await ca.EnsureCa(CaFixture.Domain)
        await store.Delete(DevCertificateAuthority.KeyRefOf(CaFixture.Domain))
        await assert.rejects(ca.EnsureCa(CaFixture.Domain), DevCaKeyMissingError)
        await assert.rejects(ca.Issue(CaFixture.Domain, [CaFixture.Wildcard]), DevCaKeyMissingError)
        assert.deepEqual(await readFile(ca.CaFileOf(CaFixture.Domain)), before)
    })
})

test('concurrent EnsureCa calls mint one CA', async () =>
{
    await CaFixture.With(async (ca) =>
    {
        const [a, b] = await Promise.all([ca.EnsureCa(CaFixture.Domain), ca.EnsureCa(CaFixture.Domain)])
        assert.deepEqual(a, b)
    })
})

test('a base domain that is a single label, a public suffix or not a valid DNS name is refused', async () =>
{
    await CaFixture.With(async (ca) =>
    {
        for (const base of CaFixture.BadBases)
        {
            await assert.rejects(ca.EnsureCa(base), DevCaError)
            await assert.rejects(ca.Issue(base, [base]), DevCaError)
        }
    })
})

test('staging is removed after an openssl failure in EnsureCa and in Issue', async () =>
{
    await CaFixture.With(async (ca, root, _vaultFile, store) =>
    {
        const broken = new DevCertificateAuthority(root, store, CaFixture.MissingOpenssl)
        // A named error the console installer may show: it says openssl failed and why.
        await assert.rejects(broken.EnsureCa(CaFixture.Domain), (e: unknown) => e instanceof DevCaError && /openssl failed/.test(e.message))
        assert.deepEqual(await readdir(root), [])
        await ca.EnsureCa(CaFixture.Domain)
        await assert.rejects(broken.Issue(CaFixture.Domain, [CaFixture.Wildcard]), DevCaError)
        assert.deepEqual(await readdir(root), [CaFixture.Domain])
    })
})

test('only stale staging dirs are swept, so a second instance cannot remove live staging', async () =>
{
    await CaFixture.With(async (ca, root) =>
    {
        const fresh = join(root, `${CaFixture.StagingPrefix}fresh`)
        const stale = join(root, `${CaFixture.StagingPrefix}stale`)
        await mkdir(fresh, { recursive: true })
        await mkdir(stale, { recursive: true })
        const old = new Date(Date.now() - CaFixture.StaleSeconds * 1000 * 2)
        await utimes(stale, old, old)
        await ca.EnsureCa(CaFixture.Domain)
        const left = await readdir(root)
        assert.ok(left.includes(`${CaFixture.StagingPrefix}fresh`))
        assert.equal(left.includes(`${CaFixture.StagingPrefix}stale`), false)
    })
})
