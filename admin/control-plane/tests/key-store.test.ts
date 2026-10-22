import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileKeyStore, KeyNotFoundError } from '../key-store.js'

class KeyStoreFixture
{
    public static readonly Ref = 'dev-key'
    public static readonly PublicPem = '-----BEGIN PUBLIC KEY-----\nPUBBYTES\n-----END PUBLIC KEY-----\n'
    public static readonly PrivatePem = '-----BEGIN PRIVATE KEY-----\nPRIVBYTES\n-----END PRIVATE KEY-----\n'
    public static readonly TempPrefix = 'keystore-'
    public static readonly Encoding = 'utf8'
}

describe('FileKeyStore', () =>
{
    let dir: string

    beforeEach(async () =>
    {
        dir = await mkdtemp(join(tmpdir(), KeyStoreFixture.TempPrefix))
        await writeFile(join(dir, `${KeyStoreFixture.Ref}${FileKeyStore.PublicSuffix}`), KeyStoreFixture.PublicPem, KeyStoreFixture.Encoding)
        await writeFile(join(dir, `${KeyStoreFixture.Ref}${FileKeyStore.PrivateSuffix}`), KeyStoreFixture.PrivatePem, KeyStoreFixture.Encoding)
    })

    afterEach(async () =>
    {
        await rm(dir, { recursive: true, force: true })
    })

    it('reads the public key by ref', async () =>
    {
        assert.equal(await new FileKeyStore(dir).PublicKey(KeyStoreFixture.Ref), KeyStoreFixture.PublicPem)
    })

    it('reads the private key by ref', async () =>
    {
        assert.equal(await new FileKeyStore(dir).PrivateKey(KeyStoreFixture.Ref), KeyStoreFixture.PrivatePem)
    })

    it('throws KeyNotFoundError naming the ref and no key bytes for an unknown ref', async () =>
    {
        const store = new FileKeyStore(dir)
        const missing = 'no-such-ref'
        for (const read of [() => store.PublicKey(missing), () => store.PrivateKey(missing)])
        {
            await assert.rejects(read, (err: Error) =>
            {
                assert.ok(err instanceof KeyNotFoundError)
                assert.ok(err.message.includes(missing))
                assert.ok(!err.message.includes('PUBBYTES'))
                assert.ok(!err.message.includes('PRIVBYTES'))
                return true
            })
        }
    })
})
