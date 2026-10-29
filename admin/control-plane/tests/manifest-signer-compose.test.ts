import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { ManifestSigner } from '../manifest-signer.js'
import { ControlPlaneServer } from '../server.js'

class SignerComposeFixture
{
    public static readonly KeyRefEnvVar = 'PRAGMATIC_ADMIN_SIGNING_KEY_REF'
}

describe('ControlPlaneServer.ManifestSignerOf', () =>
{
    const root = mkdtempSync(join(tmpdir(), 'signer-compose-'))

    after(() =>
    {
        rmSync(root, { recursive: true, force: true })
    })

    it('returns undefined when no signing key ref is configured', () =>
    {
        assert.equal(ControlPlaneServer.ManifestSignerOf({}, root), undefined)
    })

    it('returns undefined for an empty signing key ref', () =>
    {
        assert.equal(ControlPlaneServer.ManifestSignerOf({ [SignerComposeFixture.KeyRefEnvVar]: '' }, root), undefined)
    })

    it('returns undefined for a whitespace-only signing key ref', () =>
    {
        assert.equal(ControlPlaneServer.ManifestSignerOf({ [SignerComposeFixture.KeyRefEnvVar]: '   ' }, root), undefined)
    })

    it('composes a ManifestSigner when a signing key ref is configured', () =>
    {
        const signer = ControlPlaneServer.ManifestSignerOf({ [SignerComposeFixture.KeyRefEnvVar]: 'platform-release' }, root)
        assert.ok(signer instanceof ManifestSigner)
        assert.equal(typeof signer.SignForPublish, 'function')
    })
})
