import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CreateManifestViewModel } from '../src/create-manifest-view-model.js'
import type { ManifestDto } from '../src/portal-types.js'

class FakeClient
{
    public Calls: unknown[][] = []
    public Fail: Error | undefined

    public async PublishManifest(version: string, image: string, notes?: string): Promise<ManifestDto>
    {
        this.Calls.push(['PublishManifest', version, image, notes])
        if (this.Fail)
        {
            throw this.Fail
        }
        return { version, image, notes } as unknown as ManifestDto
    }
}

describe('CreateManifestViewModel', () =>
{
    it('CanSubmit requires both version and image', () =>
    {
        const vm = new CreateManifestViewModel(new FakeClient())
        assert.equal(vm.CanSubmit('', 'img'), false)
        assert.equal(vm.CanSubmit('1.0', ''), false)
        assert.equal(vm.CanSubmit('  ', 'img'), false)
        assert.equal(vm.CanSubmit('1.0', 'img'), true)
    })

    it('Submit omits blank notes and trims inputs', async () =>
    {
        const fake = new FakeClient()
        const vm = new CreateManifestViewModel(fake)
        await vm.Submit(' 1.0 ', ' img ', '  ')
        assert.deepEqual(fake.Calls, [['PublishManifest', '1.0', 'img', undefined]])
        await vm.Submit('1.1', 'img', ' n ')
        assert.deepEqual(fake.Calls[1], ['PublishManifest', '1.1', 'img', 'n'])
        assert.equal(vm.Busy, false)
        assert.equal(vm.ErrorMessage, '')
    })

    it('Submit surfaces a client error and clears busy', async () =>
    {
        const fake = new FakeClient()
        fake.Fail = new Error('boom')
        const vm = new CreateManifestViewModel(fake)
        await assert.rejects(() => vm.Submit('1.0', 'img', ''), /boom/)
        assert.equal(vm.ErrorMessage, 'boom')
        assert.equal(vm.Busy, false)
    })
})
