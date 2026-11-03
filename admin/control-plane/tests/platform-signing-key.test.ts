import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileKeyStore } from '../key-store.js'
import type { IImageSigner } from '../image-signer.js'
import type { HiveRecord } from '../platform-records.js'
import { PlatformImageSigner, PlatformSigningKey, PlatformSigningKeyIncompleteError, PlatformSigningKeyMissingError } from '../platform-signing-key.js'

class KeyFixture
{
    public static readonly Ref = PlatformSigningKey.DefaultRef
    public static readonly Payload = Buffer.from('sha256:abc')

    public static async Run(body: (keysDir: string) => Promise<void>): Promise<void>
    {
        const root = mkdtempSync(join(tmpdir(), 'platform-key-'))
        try
        {
            await body(join(root, 'keys'))
        }
        finally
        {
            rmSync(root, { recursive: true, force: true })
        }
    }

    public static Read(keysDir: string, suffix: string): string
    {
        return readFileSync(join(keysDir, KeyFixture.Ref + suffix), 'utf8')
    }
}

test('creates a working Ed25519 pair in a missing keys folder, readable through the key store', () => KeyFixture.Run(async dir =>
{
    await PlatformSigningKey.Ensure(dir, KeyFixture.Ref)
    const keys = new FileKeyStore(dir)
    const signature = sign(null, KeyFixture.Payload, createPrivateKey(await keys.PrivateKey(KeyFixture.Ref)))
    assert.equal(verify(null, KeyFixture.Payload, createPublicKey(await keys.PublicKey(KeyFixture.Ref)), signature), true)
}))

test('keeps an existing pair untouched on later starts', () => KeyFixture.Run(async dir =>
{
    await PlatformSigningKey.Ensure(dir, KeyFixture.Ref)
    const before = KeyFixture.Read(dir, FileKeyStore.PrivateSuffix)
    await PlatformSigningKey.Ensure(dir, KeyFixture.Ref)
    assert.equal(KeyFixture.Read(dir, FileKeyStore.PrivateSuffix), before)
}))

test('rebuilds a missing public half from the private key (a crash between the two writes)', () => KeyFixture.Run(async dir =>
{
    await PlatformSigningKey.Ensure(dir, KeyFixture.Ref)
    const publicBefore = KeyFixture.Read(dir, FileKeyStore.PublicSuffix)
    rmSync(join(dir, KeyFixture.Ref + FileKeyStore.PublicSuffix))
    await PlatformSigningKey.Ensure(dir, KeyFixture.Ref)
    assert.equal(KeyFixture.Read(dir, FileKeyStore.PublicSuffix), publicBefore)
}))

test('refuses a lone public half instead of regenerating the key', () => KeyFixture.Run(async dir =>
{
    await PlatformSigningKey.Ensure(dir, KeyFixture.Ref)
    rmSync(join(dir, KeyFixture.Ref + FileKeyStore.PrivateSuffix))
    await assert.rejects(PlatformSigningKey.Ensure(dir, KeyFixture.Ref), PlatformSigningKeyIncompleteError)
}))

test('concurrent first starts end with one usable pair', () => KeyFixture.Run(async dir =>
{
    await Promise.all([PlatformSigningKey.Ensure(dir, KeyFixture.Ref), PlatformSigningKey.Ensure(dir, KeyFixture.Ref), PlatformSigningKey.Ensure(dir, KeyFixture.Ref)])
    const keys = new FileKeyStore(dir)
    const signature = sign(null, KeyFixture.Payload, createPrivateKey(await keys.PrivateKey(KeyFixture.Ref)))
    assert.equal(verify(null, KeyFixture.Payload, createPublicKey(await keys.PublicKey(KeyFixture.Ref)), signature), true)
}))

test('Require accepts an operator key pair that is present and refuses a missing, partial or path-like ref', () => KeyFixture.Run(async dir =>
{
    await PlatformSigningKey.Ensure(dir, 'operator-key')
    PlatformSigningKey.Require(dir, 'operator-key')
    assert.throws(() => PlatformSigningKey.Require(dir, 'typo-key'), PlatformSigningKeyMissingError)
    assert.throws(() => PlatformSigningKey.Require(dir, '../operator-key'), PlatformSigningKeyMissingError)
    writeFileSync(join(dir, 'half' + FileKeyStore.PrivateSuffix), 'x')
    assert.throws(() => PlatformSigningKey.Require(dir, 'half'), PlatformSigningKeyMissingError)
}))

test('PlatformImageSigner signs with the platform key only, and only for hives that trust it', async () =>
{
    const calls: Array<[string, string]> = []
    const inner: IImageSigner = { Sign: async (imageRef, keyRef) => { calls.push([imageRef, keyRef]) } }
    const platform = new PlatformImageSigner(inner, 'platform-signing')
    assert.equal(platform.SignsFor({ trustRootRef: 'platform-signing' } as HiveRecord), true)
    assert.equal(platform.SignsFor({ trustRootRef: 'acme-key' } as HiveRecord), false)
    assert.equal(platform.SignsFor({} as HiveRecord), false)
    await platform.Sign('img:1')
    assert.deepEqual(calls, [['img:1', 'platform-signing']])
})

test('the private key file is owner-only where the platform supports modes', { skip: process.platform === 'win32' }, () => KeyFixture.Run(async dir =>
{
    await PlatformSigningKey.Ensure(dir, KeyFixture.Ref)
    assert.equal(statSync(join(dir, KeyFixture.Ref + FileKeyStore.PrivateSuffix)).mode & 0o777, 0o600)
}))
