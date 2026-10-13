import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DrainController } from '../drain-controller.js'
import type { IInFlightSource } from '../drain-controller.js'

class FakeClock
{
    private value = 0

    public Now(): number
    {
        return this.value
    }

    public Sleep(ms: number): Promise<void>
    {
        this.value += ms
        return Promise.resolve()
    }
}

class Countdown implements IInFlightSource
{
    private readonly counts: number[]
    private index = 0

    public constructor(counts: number[])
    {
        this.counts = counts
    }

    public InFlight(): number
    {
        const value = this.counts[Math.min(this.index, this.counts.length - 1)]!
        this.index += 1
        return value
    }
}

test('drains the moment the count reaches zero (Review Focus 2)', async () =>
{
    const clock = new FakeClock()
    const controller = new DrainController(1000, () => clock.Now(), ms => clock.Sleep(ms), 25)
    const outcome = await controller.WaitForDrain(new Countdown([0]))
    assert.equal(outcome.Drained, true)
    assert.equal(outcome.Remaining, 0)
})

test('waits while in-flight is positive, then completes when it drops to zero', async () =>
{
    const clock = new FakeClock()
    const controller = new DrainController(1000, () => clock.Now(), ms => clock.Sleep(ms), 25)
    const outcome = await controller.WaitForDrain(new Countdown([3, 2, 1, 0]))
    assert.equal(outcome.Drained, true)
    assert.equal(outcome.Remaining, 0)
    assert.equal(outcome.ElapsedMs, 75)
})

test('times out and reports the remaining count (Review Focus 2)', async () =>
{
    const clock = new FakeClock()
    const controller = new DrainController(50, () => clock.Now(), ms => clock.Sleep(ms), 25)
    const outcome = await controller.WaitForDrain(new Countdown([4]))
    assert.equal(outcome.Drained, false)
    assert.equal(outcome.Remaining, 4)
    assert.ok(outcome.ElapsedMs >= 50)
})

test('a throwing in-flight source is treated as drained and never hangs (Review Focus 3)', async () =>
{
    const clock = new FakeClock()
    const controller = new DrainController(1000, () => clock.Now(), ms => clock.Sleep(ms), 25)
    const outcome = await controller.WaitForDrain({ InFlight: () => { throw new Error('boom') } })
    assert.equal(outcome.Drained, true)
    assert.equal(outcome.Remaining, 0)
})

test('a non-positive pollMs is clamped to 1 so the wait never spins on zero-delay sleeps', async () =>
{
    const clock = new FakeClock()
    const sleeps: number[] = []
    const controller = new DrainController(1000, () => clock.Now(), ms =>
    {
        sleeps.push(ms)
        return clock.Sleep(ms)
    }, 0)
    const outcome = await controller.WaitForDrain(new Countdown([2, 0]))
    assert.equal(outcome.Drained, true)
    assert.equal(outcome.Remaining, 0)
    assert.ok(outcome.ElapsedMs >= 1)
    assert.deepEqual(sleeps, [1])
})

test('a zero timeout with a non-zero count returns immediately (preserves pre-Stage-C teardown)', async () =>
{
    const clock = new FakeClock()
    const controller = new DrainController(0, () => clock.Now(), ms => clock.Sleep(ms), 25)
    const outcome = await controller.WaitForDrain(new Countdown([2]))
    assert.equal(outcome.Drained, false)
    assert.equal(outcome.Remaining, 2)
    assert.equal(outcome.ElapsedMs, 0)
})
