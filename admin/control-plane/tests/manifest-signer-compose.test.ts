import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ManifestSigner } from '../manifest-signer.js'
import { ControlPlaneServer } from '../server.js'

describe('ControlPlaneServer.ManifestSignerOf', () =>
{
    const root = mkdtempSync(join(tmpdir(), 'signer-compose-'))

    it('returns undefined when no signing key ref is configured', () =>
    {
        assert.equal(ControlPlaneServer.ManifestSignerOf({}, root), undefined)
    })

    it('returns undefined for an empty signing key ref', () =>
    {
        assert.equal(ControlPlaneServer.ManifestSignerOf({ PRAGMATIC_ADMIN_SIGNING_KEY_REF: '' }, root), undefined)
    })

    it('composes a ManifestSigner when a signing key ref is configured', () =>
    {
        const signer = ControlPlaneServer.ManifestSignerOf({ PRAGMATIC_ADMIN_SIGNING_KEY_REF: 'platform-release' }, root)
        assert.ok(signer instanceof ManifestSigner)
    })
})
