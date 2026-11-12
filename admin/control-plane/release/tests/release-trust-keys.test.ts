import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ReleaseTrustKeyInvalidError, ReleaseTrustKeys } from '../release-trust-keys.js'

class PemFixture
{
    public static Ed25519(): string
    {
        return generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    }

    public static Rsa(): string
    {
        return generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString()
    }
}

describe('ReleaseTrustKeys', () =>
{
    const dirs: string[] = []

    before(() =>
    {
        dirs.length = 0
    })

    after(() =>
    {
        for (const dir of dirs)
        {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    const makeDir = (files: Record<string, string>): string =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'release-keys-'))
        dirs.push(dir)
        for (const [name, content] of Object.entries(files))
        {
            writeFileSync(join(dir, name), content)
        }
        return dir
    }

    it('loads every .pub.pem and ignores other files', () =>
    {
        const keys = ReleaseTrustKeys.FromDirectory(makeDir({
            'a.pub.pem': PemFixture.Ed25519(),
            'b.pub.pem': PemFixture.Ed25519(),
            'notes.txt': 'hello',
        }))
        assert.deepEqual(keys.Ids, ['a', 'b'])
        assert.ok(keys.KeyFor('a')?.includes('PUBLIC KEY'))
        assert.equal(keys.KeyFor('c'), undefined)
    })

    it('rejects a non-Ed25519 key', () =>
    {
        const dir = makeDir({ 'bad.pub.pem': PemFixture.Rsa() })
        assert.throws(() => ReleaseTrustKeys.FromDirectory(dir), (e: unknown) => e instanceof ReleaseTrustKeyInvalidError && e.message.endsWith('bad'))
    })

    it('rejects unparseable key content', () =>
    {
        const dir = makeDir({ 'junk.pub.pem': 'garbage' })
        assert.throws(() => ReleaseTrustKeys.FromDirectory(dir), ReleaseTrustKeyInvalidError)
    })

    it('loads the committed release-keys directory', () =>
    {
        const keys = ReleaseTrustKeys.FromDirectory(resolve(import.meta.dirname, '../../../../release-keys'))
        assert.ok(keys.Ids.includes('release-2026-11'))
    })
})
