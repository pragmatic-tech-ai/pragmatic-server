import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Channel } from '../../channel.js'
import { ReleaseTag, ReleaseTagInvalidError } from '../release-tag.js'

describe('ReleaseTag', () =>
{
    it('parses a stable tag', () =>
    {
        const tag = ReleaseTag.Parse('release/1.4.0')
        assert.equal(tag.Version, '1.4.0')
        assert.equal(tag.Channel, Channel.Stable)
    })

    it('parses a full ref with an early-access suffix', () =>
    {
        const tag = ReleaseTag.Parse('refs/tags/release/2.0.1-early.3')
        assert.equal(tag.Version, '2.0.1-early.3')
        assert.equal(tag.Channel, Channel.EarlyAccess)
    })

    for (const bad of ['release/1.4', 'release/v1.4.0', 'release/1.4.0-rc1', 'v1.4.0', 'release/01.4.0'])
    {
        it(`rejects ${bad}`, () =>
        {
            assert.throws(() => ReleaseTag.Parse(bad), ReleaseTagInvalidError)
        })
    }
})
