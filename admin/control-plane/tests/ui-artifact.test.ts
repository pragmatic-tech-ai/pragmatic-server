import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UiArtifact, UiArtifactError } from '../ui-artifact.js'
import { OciRegistryClient } from '../oci-registry-client.js'

class Fx
{
    public static Enc(s: string): Uint8Array
    {
        return new TextEncoder().encode(s)
    }

    public static readonly Cfg = { appName: 'northwind', appVersion: '1.0.0', entry: 'index.html', assets: ['a/app.js', 'a/b.css'] }
    public static readonly FileA = { path: 'index.html', bytes: Fx.Enc('<html>') }
    public static readonly FileB = { path: 'a/app.js', bytes: Fx.Enc('x=1') }
}

test('Pack then Unpack round-trips the files exactly', () =>
{
    const a = UiArtifact.Pack(Fx.Cfg, [Fx.FileA, Fx.FileB])
    const out = UiArtifact.Unpack(a.layerBlob)
    assert.equal(out.length, 2)
    for (const f of [Fx.FileA, Fx.FileB])
    {
        const m = out.find(o => o.path === f.path)
        assert.ok(m)
        assert.ok(Buffer.from(m.bytes).equals(Buffer.from(f.bytes)))
    }
})

test('the manifest digest is reproducible for identical input regardless of file order', () =>
{
    const x = UiArtifact.Pack(Fx.Cfg, [Fx.FileA, Fx.FileB])
    const y = UiArtifact.Pack({ ...Fx.Cfg, assets: [...Fx.Cfg.assets].reverse() }, [Fx.FileB, Fx.FileA])
    assert.equal(x.manifestDigest, y.manifestDigest)
    assert.equal(x.manifestDigest, UiArtifact.ManifestDigestOf(x.manifestBytes))
})

test('the manifest references the config and layer blobs by their sha256 digests and declares the pragmatic UI media types', () =>
{
    const a = UiArtifact.Pack(Fx.Cfg, [Fx.FileA, Fx.FileB])
    const m = JSON.parse(Buffer.from(a.manifestBytes).toString())
    assert.equal(m.schemaVersion, 2)
    assert.equal(m.config.mediaType, 'application/vnd.pragmatic.ui.config.v1+json')
    assert.equal(m.layers[0].mediaType, 'application/vnd.pragmatic.ui.layer.v1+json')
    assert.equal(m.config.digest, OciRegistryClient.DigestOf(a.configBlob))
    assert.equal(m.layers[0].digest, OciRegistryClient.DigestOf(a.layerBlob))
    assert.equal(m.layers[0].size, a.layerBlob.byteLength)
})

test('binary bytes including 0x00 and 0xff survive a round-trip', () =>
{
    const bin = { path: 'b.bin', bytes: new Uint8Array([0, 255, 1, 254, 0, 128]) }
    const out = UiArtifact.Unpack(UiArtifact.Pack(Fx.Cfg, [bin]).layerBlob)
    assert.ok(Buffer.from(out[0].bytes).equals(Buffer.from(bin.bytes)))
})

test('different input orders produce byte-identical layer blobs', () =>
{
    const x = UiArtifact.Pack(Fx.Cfg, [Fx.FileA, Fx.FileB])
    const y = UiArtifact.Pack(Fx.Cfg, [Fx.FileB, Fx.FileA])
    assert.ok(Buffer.from(x.layerBlob).equals(Buffer.from(y.layerBlob)))
})

test('a file named __proto__ round-trips through Pack and Unpack', () =>
{
    const proto = { path: '__proto__', bytes: new Uint8Array([1, 2, 3]) }
    const out = UiArtifact.Unpack(UiArtifact.Pack(Fx.Cfg, [Fx.FileA, proto]).layerBlob)
    const found = out.find(f => f.path === '__proto__')
    assert.ok(found)
    assert.deepEqual([...found.bytes], [1, 2, 3])
    assert.equal(out.length, 2)
})

test('Pack rejects a duplicate path', () =>
{
    assert.throws(() => UiArtifact.Pack(Fx.Cfg, [Fx.FileA, { path: Fx.FileA.path, bytes: Fx.FileB.bytes }]), UiArtifactError)
})

test('Unpack rejects a malformed layer blob', () =>
{
    assert.throws(() => UiArtifact.Unpack(Fx.Enc('not json')), UiArtifactError)
    assert.throws(() => UiArtifact.Unpack(Fx.Enc('[1]')), UiArtifactError)
    assert.throws(() => UiArtifact.Unpack(Fx.Enc('{"a":1}')), UiArtifactError)
})
