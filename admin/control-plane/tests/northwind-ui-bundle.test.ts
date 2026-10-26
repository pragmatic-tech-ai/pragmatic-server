import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NorthwindUiBundle } from '../northwind-ui-bundle.js'
import { UiArtifact } from '../ui-artifact.js'

test('Load returns the northwind config and the two UI files', () =>
{
    const b = NorthwindUiBundle.Load()
    assert.equal(b.config.appName, 'northwind')
    assert.equal(b.config.entry, 'index.html')
    assert.deepEqual([...b.config.assets], ['assets/app.js'])
    assert.deepEqual(b.files.map(f => f.path).sort(), ['assets/app.js', 'index.html'])
    const shell = Buffer.from(b.files.find(f => f.path === 'index.html')!.bytes).toString('utf8')
    assert.ok(shell.includes(NorthwindUiBundle.Marker))
    assert.ok(shell.includes('<script src="assets/app.js"></script>'))
})

test('the loaded bundle packs and unpacks losslessly', () =>
{
    const b = NorthwindUiBundle.Load()
    const packed = UiArtifact.Pack(b.config, b.files)
    const out = UiArtifact.Unpack(packed.layerBlob)
    assert.deepEqual(out.map(f => f.path).sort(), ['assets/app.js', 'index.html'])
    for (const original of b.files)
    {
        const restored = out.find(f => f.path === original.path)!
        assert.ok(Buffer.from(restored.bytes).equals(Buffer.from(original.bytes)), original.path)
    }
})
