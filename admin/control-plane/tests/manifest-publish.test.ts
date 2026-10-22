import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ManifestPublish, ManifestPublishUsageError } from '../manifest-publish.js'

test('ParseArgs returns version and image', () =>
{
    const parsed = ManifestPublish.ParseArgs(['--version', '1.0.0', '--image', 'pragmatic-server:dev'])
    assert.deepEqual(parsed, { version: '1.0.0', image: 'pragmatic-server:dev' })
    assert.equal(parsed.notes, undefined)
})

test('ParseArgs populates optional notes', () =>
{
    const parsed = ManifestPublish.ParseArgs(['--version', '1.0.0', '--image', 'img:1', '--notes', 'hello'])
    assert.equal(parsed.notes, 'hello')
})

test('ParseArgs throws a usage error when --version is missing', () =>
{
    assert.throws(() => ManifestPublish.ParseArgs(['--image', 'img:1']), ManifestPublishUsageError)
})

test('ParseArgs throws a usage error when --image is missing', () =>
{
    assert.throws(() => ManifestPublish.ParseArgs(['--version', '1.0.0']), ManifestPublishUsageError)
})

test('ParseArgs throws a usage error when a flag has no value', () =>
{
    assert.throws(() => ManifestPublish.ParseArgs(['--version', '--image', 'img:1']), ManifestPublishUsageError)
})
