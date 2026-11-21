import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { ReleaseTrustKeys } from '@pragmatic-tech-ai/pragmatic-release-toolkit'

/** This checkout's release-keys: the trust the console defaults to and the release workflow publishes against. */
class ShippedKeys
{
    public static readonly Dir = resolve(import.meta.dirname, '../../../../release-keys')
    public static readonly KeyId = 'release-2026-11'
}

describe('release-keys', () =>
{
    it('loads the committed release-keys directory, which holds the shipped key', () =>
    {
        const keys = ReleaseTrustKeys.FromDirectory(ShippedKeys.Dir)
        assert.ok(keys.Ids.includes(ShippedKeys.KeyId))
        assert.ok(keys.KeyFor(ShippedKeys.KeyId) !== undefined)
    })
})
