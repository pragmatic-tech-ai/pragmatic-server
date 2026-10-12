import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProvisionedSecretSource } from '../provisioned-secret-source.js'

test('FromText parses a ref-to-value map and Lookup returns a hit', () =>
{
    const source = ProvisionedSecretSource.FromText('{"acme/oidc/client-secret":"s3cr3t"}')
    assert.equal(source.Lookup('acme/oidc/client-secret'), 's3cr3t')
})

test('Lookup returns null for an absent or empty ref', () =>
{
    const source = ProvisionedSecretSource.FromText('{"a":"1"}')
    assert.equal(source.Lookup('missing'), null)
    assert.equal(source.Lookup(''), null)
})

test('FromText rejects non-JSON with a sanitized message naming no value', () =>
{
    assert.throws(() => ProvisionedSecretSource.FromText('not json'), (e: unknown) =>
    {
        const message = (e as Error).message
        assert.match(message, /provisioned secrets file is not valid JSON/)
        assert.doesNotMatch(message, /not json/)
        return true
    })
})

test('FromText rejects a non-object shape', () =>
{
    assert.throws(() => ProvisionedSecretSource.FromText('["a"]'), /provisioned secrets file has an invalid shape/)
    assert.throws(() => ProvisionedSecretSource.FromText('"x"'), /provisioned secrets file has an invalid shape/)
    assert.throws(() => ProvisionedSecretSource.FromText('null'), /provisioned secrets file has an invalid shape/)
})

test('FromText rejects a non-string value naming neither key nor value', () =>
{
    assert.throws(() => ProvisionedSecretSource.FromText('{"ref":123}'), (e: unknown) =>
    {
        const message = (e as Error).message
        assert.match(message, /provisioned secrets file has an invalid shape/)
        assert.doesNotMatch(message, /ref/)
        assert.doesNotMatch(message, /123/)
        return true
    })
})

test('FromText preserves a value with special characters (Review Focus 3)', () =>
{
    const value = 'a"b\\c\nd\tеé'
    const source = ProvisionedSecretSource.FromText(JSON.stringify({ k: value }))
    assert.equal(source.Lookup('k'), value)
})

test('FromText accepts an empty object', () =>
{
    const source = ProvisionedSecretSource.FromText('{}')
    assert.equal(source.Lookup('anything'), null)
})
