import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { InternalApiCredential } from '../internal-api-credential.js'

class CredentialFixture
{
    public static readonly Root = mkdtempSync(join(tmpdir(), 'internal-cred-'))
    public static readonly Secret = 'S3CRET-'.padEnd(48, 'x')

    public static File(content: string | Buffer): string
    {
        const path = join(mkdtempSync(join(CredentialFixture.Root, 'f-')), 'secret')
        writeFileSync(path, content, { mode: 0o600 })
        return path
    }
}

describe('InternalApiCredential', () =>
{
    after(() => rmSync(CredentialFixture.Root, { recursive: true, force: true }))

    it('derives the same bearer from the same secret, and it is not the secret', () =>
    {
        const a = InternalApiCredential.FromFile(CredentialFixture.File(CredentialFixture.Secret))
        const b = InternalApiCredential.FromFile(CredentialFixture.File(CredentialFixture.Secret))
        assert.equal(a.Bearer(), b.Bearer())
        assert.ok(!a.Bearer().includes('S3CRET'))
        assert.match(a.Bearer(), /^[A-Za-z0-9_-]{43}$/)
    })

    it('matches its own bearer and nothing else', () =>
    {
        const c = InternalApiCredential.FromFile(CredentialFixture.File(CredentialFixture.Secret))
        assert.equal(c.Matches(c.Bearer()), true)
        assert.equal(c.Matches(''), false)
        assert.equal(c.Matches('x'), false)
        assert.equal(c.Matches(c.Bearer() + 'x'), false)
        const other = InternalApiCredential.FromFile(CredentialFixture.File('O'.repeat(48)))
        assert.equal(c.Matches(other.Bearer()), false)
    })

    it('refuses a secret shorter than 32 bytes or a missing file, naming the setting and never the bytes', () =>
    {
        for (const path of [CredentialFixture.File('SHORT-SECRET-123'), join(CredentialFixture.Root, 'nope')])
        {
            assert.throws(() => InternalApiCredential.FromFile(path), (e: Error) =>
            {
                assert.match(e.message, /PRAGMATIC_INTERNAL_API_SECRET_FILE/)
                assert.ok(!e.message.includes('SHORT-SECRET'))
                return true
            })
        }
    })
})
