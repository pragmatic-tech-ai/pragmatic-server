import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { InternalApiCredential, InternalApiSecretError } from '@pragmatic-tech-ai/pragmatic-app-host'
import { InternalApiLink, InternalApiLinkError } from '../internal-api-link.js'

/** The edge to platform admin console link: an independent derivation of the bearer both ends present. */
class LinkFixture
{
    public static readonly Root = mkdtempSync(join(tmpdir(), 'internal-link-'))
    public static readonly Secret = 'S3CRET-'.padEnd(48, 'x')
    public static readonly Label = 'pragmatic-internal-api/v1'

    public static ExpectedBearer(): string
    {
        return createHmac('sha256', Buffer.from(LinkFixture.Secret)).update(LinkFixture.Label).digest('base64url')
    }

    public static File(content: string): string
    {
        const path = join(mkdtempSync(join(LinkFixture.Root, 'f-')), 'secret')
        writeFileSync(path, content, { mode: 0o600 })
        return path
    }
}

describe('InternalApiLink', () =>
{
    after(() => rmSync(LinkFixture.Root, { recursive: true, force: true }))

    it('is app-host\'s default-label credential, bit-identical to the edge and console of earlier releases', () =>
    {
        assert.equal(InternalApiCredential.DefaultLabel, LinkFixture.Label)
        assert.equal(InternalApiLink.Credential(LinkFixture.File(LinkFixture.Secret)).Bearer(), LinkFixture.ExpectedBearer())
    })

    it('refuses a secret shorter than 32 bytes or a missing file, naming the setting and never the bytes', () =>
    {
        for (const path of [LinkFixture.File('SHORT-SECRET-123'), join(LinkFixture.Root, 'nope')])
        {
            assert.throws(() => InternalApiLink.Credential(path), (e: Error) =>
            {
                assert.ok(e instanceof InternalApiLinkError)
                assert.ok(e.cause instanceof InternalApiSecretError)
                assert.match(e.message, /^PRAGMATIC_INTERNAL_API_SECRET_FILE: /)
                assert.ok(!e.message.includes('SHORT-SECRET'))
                return true
            })
        }
    })
})
