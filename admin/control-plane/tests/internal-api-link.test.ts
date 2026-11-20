import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { describe, it } from 'node:test'
import { InternalApiCredential } from '@pragmatic-tech-ai/pragmatic-app-host'

/** The edge to platform admin console link: an independent derivation of the bearer both ends present. */
class LinkFixture
{
    public static readonly Secret = Buffer.from('S3CRET-'.padEnd(48, 'x'))
    public static readonly Label = 'pragmatic-internal-api/v1'

    public static ExpectedBearer(): string
    {
        return createHmac('sha256', LinkFixture.Secret).update(LinkFixture.Label).digest('base64url')
    }
}

describe('the internal API link credential', () =>
{
    it('is app-host\'s default-label credential, bit-identical to the edge and console of earlier releases', () =>
    {
        assert.equal(InternalApiCredential.DefaultLabel, LinkFixture.Label)
        assert.equal(InternalApiCredential.FromSecret(LinkFixture.Secret).Bearer(), LinkFixture.ExpectedBearer())
    })
})
