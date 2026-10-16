import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PortAllocator, PortUnavailableError } from '../port-allocator.js'
import type { IPortProbe } from '../port-allocator.js'

class FakeProbe implements IPortProbe
{
    public constructor(private readonly busy: ReadonlySet<number>, private readonly allBusy = false)
    {
    }

    public async Free(port: number): Promise<boolean>
    {
        return !this.allBusy && !this.busy.has(port)
    }
}

describe('PortAllocator', () =>
{
    const floor = 5000

    it('skips taken and OS-busy ports', async () =>
    {
        const allocator = new PortAllocator(floor, new FakeProbe(new Set([floor + 1])))
        assert.equal(await allocator.Allocate([floor]), floor + 2)
    })

    it('returns the floor when free', async () =>
    {
        const allocator = new PortAllocator(floor, new FakeProbe(new Set()))
        assert.equal(await allocator.Allocate([]), floor)
    })

    it('throws when every port is busy', async () =>
    {
        const allocator = new PortAllocator(floor, new FakeProbe(new Set(), true))
        await assert.rejects(allocator.Allocate([]), (e: Error) => e instanceof PortUnavailableError && e.message.includes('5000-8999'))
    })

    it('Check rejects taken ports', async () =>
    {
        const allocator = new PortAllocator(floor, new FakeProbe(new Set()))
        await assert.rejects(allocator.Check(6000, [6000]), PortUnavailableError)
    })

    it('Check rejects OS-busy ports', async () =>
    {
        const allocator = new PortAllocator(floor, new FakeProbe(new Set([6001])))
        await assert.rejects(allocator.Check(6001, []), PortUnavailableError)
    })

    it('Check accepts free ports', async () =>
    {
        const allocator = new PortAllocator(floor, new FakeProbe(new Set()))
        await allocator.Check(6002, [])
    })
})
