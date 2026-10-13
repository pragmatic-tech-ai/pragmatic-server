import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IdentityPackKind, IdentityPackKinds } from '../identity-pack-kind.js'

test('known pack ids map to kinds', () =>
{
    assert.equal(IdentityPackKinds.FromPackId('entra'), IdentityPackKind.Entra)
    assert.equal(IdentityPackKinds.FromPackId('google'), IdentityPackKind.Google)
    assert.equal(IdentityPackKinds.FromPackId('local'), IdentityPackKind.Local)
})

test('an unknown pack id fails closed naming the id', () =>
{
    assert.throws(() => IdentityPackKinds.FromPackId('okta'), /unknown identity pack: okta/)
})
