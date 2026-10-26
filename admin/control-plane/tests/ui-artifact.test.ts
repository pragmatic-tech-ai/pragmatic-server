import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UiArtifact } from '../ui-artifact.js'
import { OciRegistryClient } from '../oci-registry-client.js'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const cfg = { appName: 'northwind', appVersion: '1.0.0', entry: 'index.html', assets: ['a/app.js', 'a/b.css'] }
const fileA = { path: 'index.html', bytes: enc('<html>') }
const fileB = { path: 'a/app.js', bytes: enc('x=1') }

test('Pack then Unpack round-trips the files exactly', () =>
{
    const a = UiArtifact.Pack(cfg, [fileA, fileB])
    const out = UiArtifact.Unpack(a.layerBlob)
    assert.equal(out.length, 2)
    for (const f of [fileA, fileB])
    {
        const m = out.find(o => o.path === f.path)
        assert.ok(m)
        assert.ok(Buffer.from(m.bytes).equals(Buffer.from(f.bytes)))
    }
})

test('the manifest digest is reproducible for identical input regardless of file order', () =>
{
    const x = UiArtifact.Pack(cfg, [fileA, fileB])
    const y = UiArtifact.Pack({ ...cfg, assets: [...cfg.assets].reverse() }, [fileB, fileA])
    assert.equal(x.manifestDigest, y.manifestDigest)
    assert.equal(x.manifestDigest, UiArtifact.ManifestDigestOf(x.manifestBytes))
})

test('the manifest references the config and layer blobs by their sha256 digests and declares the pragmatic UI media types', () =>
{
    const a = UiArtifact.Pack(cfg, [fileA, fileB])
    const m = JSON.parse(Buffer.from(a.manifestBytes).toString())
    assert.equal(m.schemaVersion, 2)
    assert.equal(m.config.mediaType, 'application/vnd.pragmatic.ui.config.v1+json')
    assert.equal(m.layers[0].mediaType, 'application/vnd.pragmatic.ui.layer.v1+json')
    assert.equal(m.config.digest, OciRegistryClient.DigestOf(a.configBlob))
    assert.equal(m.layers[0].digest, OciRegistryClient.DigestOf(a.layerBlob))
    assert.equal(m.layers[0].size, a.layerBlob.byteLength)
})
