import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { createPublicKey, randomBytes, X509Certificate } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SealedSecretStore } from '../sealed-secret-store.js'
import { DevCaHostOutsideDomainError, DevCaKeyMissingError, DevCertificateAuthority } from '../dev-certificate-authority.js'

class CaFixture
{
    public static readonly Prefix = 'devca-'
    public static readonly Domain = 'localtest.me'
    public static readonly Wildcard = '*.localtest.me'
    public static readonly PrivateKeyMarker = 'PRIVATE KEY'
    public static readonly KeySuffix = '.key'
    public static readonly Encoding = 'utf8'
    public static readonly MaxLeafMs = 398 * 24 * 3600 * 1000

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
        assert.ok(leaf.subjectAltName?.includes('DNS:*.localtest.me'))
        assert.ok(leaf.subjectAltName?.includes('DNS:localtest.me'))
        assert.ok(new Date(leaf.validTo).getTime() - new Date(leaf.validFrom).getTime() <= CaFixture.MaxLeafMs)
        assert.equal(leaf.ca, false)
        const fromKey = createPublicKey(issued.key).export({ type: 'spki', format: 'der' })
        assert.deepEqual(fromKey, leaf.publicKey.export({ type: 'spki', format: 'der' }))
    })
})

test('Issue refuses a host outside the base domain and an inner wildcard', async () =>
{
    await CaFixture.With(async (ca) =>
    {
        await assert.rejects(ca.Issue(CaFixture.Domain, ['console.example.com']), DevCaHostOutsideDomainError)
        await assert.rejects(ca.Issue(CaFixture.Domain, ['evillocaltest.me']), DevCaHostOutsideDomainError)
        await assert.rejects(ca.Issue(CaFixture.Domain, ['a.*.localtest.me']), DevCaHostOutsideDomainError)
        await assert.rejects(ca.Issue(CaFixture.Domain, ['x*.localtest.me']), DevCaHostOutsideDomainError)
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
