import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { AdoptWizard } from '../src/adopt-wizard.js'
import { AdoptOutcome, EnvStepKind } from '../src/releases-view-model.js'
import type { AdoptResult, ReleasesViewModel } from '../src/releases-view-model.js'
import { EnvStatus } from '../src/tenant-types.js'

class FakeVm
{
    public LastResult: AdoptResult | undefined
    public Calls = 0
    public Versions = [{ manifest: { id: 'v2', image: 'img', notes: 'fixes things', publishedAt: '2026-10-01' }, version: 'v2', badge: 0, withdrawn: false }]

    public constructor(private readonly outcome: AdoptOutcome, private readonly message?: string)
    {
    }

    public EnvSteps(_version: string): unknown[]
    {
        return [{ environmentName: 'alpha', status: EnvStatus.Running, kind: EnvStepKind.WillRestart, label: 'Will restart' }]
    }

    public Impact(_version: string): string
    {
        return 'Rolling to v2 restarts: alpha'
    }

    public async ConfirmAdopt(_version: string): Promise<AdoptOutcome>
    {
        this.Calls++
        await Promise.resolve()
        this.LastResult = { outcome: this.outcome, message: this.message }
        return this.outcome
    }
}

class Fixtures
{
    public static Make(outcome: AdoptOutcome, message?: string, onClose: () => void = () => undefined): { w: AdoptWizard; vm: FakeVm }
    {
        const vm = new FakeVm(outcome, message)
        return { w: new AdoptWizard({ vm: vm as unknown as ReleasesViewModel, version: 'v2', onClose }), vm }
    }

    public static Collect(v: Visual, out: Visual[] = []): Visual[]
    {
        out.push(v)
        for (const c of v.visualChildren)
        {
            Fixtures.Collect(c, out)
        }
        return out
    }

    public static Texts(v: Visual): string[]
    {
        return Fixtures.Collect(v).map(x => (x as unknown as { Text?: unknown }).Text).filter((t): t is string => typeof t === 'string')
    }

    public static Click(v: Visual, label: string): void
    {
        const b = Fixtures.Collect(v).find(x => x instanceof Button && (x.Content as unknown as { Text?: string })?.Text === label)
        assert.ok(b, 'button not found: ' + label)
        for (const h of (b as unknown as { _clickHandlers: Array<(a: unknown) => void> })._clickHandlers)
        {
            h({})
        }
    }
}

describe('AdoptWizard', () =>
{
    before(() =>
    {
        const app = new Application()
        Application.current = app
        app.initialize({ theme: Pragmatic, scheme: PragmaticLight })
    })

    it('Next walks Version, Environments, Review', () =>
    {
        const { w } = Fixtures.Make(AdoptOutcome.Adopted)
        assert.equal(w.ActiveStep, 0)
        assert.ok(Fixtures.Texts(w.ContentHost).includes('Notes: fixes things'))
        w.Next()
        assert.equal(w.ActiveStep, 1)
        assert.ok(Fixtures.Texts(w.ContentHost).includes('alpha - Will restart'))
        w.Next()
        assert.equal(w.ActiveStep, 2)
        w.Back()
        assert.equal(w.ActiveStep, 1)
    })

    it('Review shows the impact and the trust note', () =>
    {
        const { w } = Fixtures.Make(AdoptOutcome.Adopted)
        w.Next()
        w.Next()
        const t = Fixtures.Texts(w.ContentHost)
        assert.ok(t.includes('Rolling to v2 restarts: alpha'))
        assert.ok(t.includes(AdoptWizard.TrustNote))
    })

    it('Roll out runs the adopt then lands on Outcome (adopted)', async () =>
    {
        const { w, vm } = Fixtures.Make(AdoptOutcome.Adopted)
        w.Next()
        w.Next()
        Fixtures.Click(w.ContentHost, 'Roll out')
        assert.equal(w.ActiveStep, 3)
        assert.ok(Fixtures.Texts(w.ContentHost).includes(AdoptWizard.RollingText))
        await w.Settled
        assert.equal(vm.Calls, 1)
        assert.equal(w.ActiveStep, 4)
        assert.ok(Fixtures.Texts(w.ContentHost).includes(AdoptWizard.AdoptedText))
    })

    it('Refused shows the server message and no adopted claim', async () =>
    {
        const { w } = Fixtures.Make(AdoptOutcome.Refused, 'image failed verification')
        w.Next()
        w.Next()
        w.Next()
        await w.Settled
        const t = Fixtures.Texts(w.ContentHost)
        assert.ok(t.includes('image failed verification'))
        assert.ok(t.includes(AdoptWizard.RefusedText))
        assert.ok(!t.includes(AdoptWizard.AdoptedText))
    })

    it('Close calls onClose', async () =>
    {
        let closed = 0
        const { w } = Fixtures.Make(AdoptOutcome.Unavailable, 'try later', () => { closed++ })
        w.Next()
        w.Next()
        w.Next()
        await w.Settled
        assert.ok(Fixtures.Texts(w.ContentHost).includes('try later'))
        Fixtures.Click(w.ContentHost, 'Close')
        assert.equal(closed, 1)
    })
})
