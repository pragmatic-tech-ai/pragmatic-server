import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { ConsoleComponents } from '../../configuration/console-components.js'
import { ComponentDescriptorSet, ComponentDescriptorSetDigestError } from '../component-descriptor-set.js'
import { ReleaseComponents } from '../release-components.js'
import { ReleaseApps } from '../release-tag.js'

class VendoredFixture
{
    public static readonly Directory = ConsoleComponents.VendoredDirectory()
    public static readonly Scratch = mkdtempSync(join(tmpdir(), 'descriptor-set-'))
}

describe('ComponentDescriptorSet', () =>
{
    after(() => rmSync(VendoredFixture.Scratch, { recursive: true, force: true }))

    it('loads the nine vendored descriptors and their digests equal the declaration goldens', () =>
    {
        const set = ComponentDescriptorSet.FromDirectory(VendoredFixture.Directory)
        assert.deepEqual(set.All().map(d => d.Name).sort(), [...ReleaseApps.All].sort())
        for (const [app, declared] of ReleaseComponents.All())
        {
            assert.equal(set.Get(app)?.ContentDigest(), declared.ContentDigest(), app)
        }
    })

    it('refuses a file whose content does not hash to its pinned digest', () =>
    {
        const copy = join(VendoredFixture.Scratch, 'tampered')
        cpSync(VendoredFixture.Directory, copy, { recursive: true })
        const file = join(copy, 'pragmatic-hive-agent.json')
        const document = JSON.parse(readFileSync(file, 'utf8')) as { version: string }
        document.version = '9.9.9'
        writeFileSync(file, JSON.stringify(document))
        assert.throws(() => ComponentDescriptorSet.FromDirectory(copy), (e: Error) => e instanceof ComponentDescriptorSetDigestError && /pragmatic-hive-agent/.test(e.message))
    })

    it('answers undefined for a component it does not carry', () =>
    {
        assert.equal(ComponentDescriptorSet.FromDirectory(VendoredFixture.Directory).Get('pragmatic-unknown'), undefined)
    })
})
