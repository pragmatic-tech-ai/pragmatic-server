import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { ApiError } from '../src/api-client.js'
import type { ControlPlaneClient } from '../src/api-client.js'
import { OperatorContext } from '../src/operator-context.js'
import { ProvisionWizardView, WizardViewMode } from '../src/provision-wizard-view.js'
import type { ProvisionInputDto, ProvisionResultDto } from '../src/portal-types.js'

class FakeClient
{
    public Calls = 0
    public Error: Error | undefined
    public Gate: Promise<void> | undefined

    public async Provision(input: ProvisionInputDto): Promise<ProvisionResultDto>
    {
        this.Calls++
        if (this.Gate !== undefined)
        {
            await this.Gate
        }
        if (this.Error !== undefined)
        {
            return Promise.reject(this.Error)
        }
        return Promise.resolve({
            client: { id: input.client.id, displayName: input.client.displayName },
            tenant: { id: input.tenant.id, clientId: input.client.id, displayName: input.tenant.displayName },
            hive: { id: input.hive.id, tenantId: input.tenant.id, displayName: input.hive.displayName, cluster: input.hive.cluster, registry: input.hive.registry },
            secrets: { ownerEmail: input.tenant.ownerEmail, ownerPassword: Fixtures.Password, agentToken: Fixtures.Token },
        } as unknown as ProvisionResultDto)
    }
}

class Fixtures
{
    public static readonly Password = 'pw-one-time'
    public static readonly Token = 'tok-one-time'

    public static Walk(root: unknown): unknown[]
    {
        const out: unknown[] = [root]
        const children = (root as { Children?: Iterable<unknown> }).Children
        for (const c of children ?? [])
        {
            out.push(...Fixtures.Walk(c))
        }
        return out
    }

    public static Texts(view: unknown): string[]
    {
        return Fixtures.Walk(view).filter(n => n instanceof TextBlock).map(n => (n as TextBlock).Text)
    }

    public static async Tick(): Promise<void>
    {
        await new Promise(r => setTimeout(r, 0))
    }

    public static Fill(view: ProvisionWizardView): void
    {
        const m = view.Model
        m.ClientId = 'c1'
        m.ClientDisplayName = 'Client One'
        m.TenantId = 't1'
        m.TenantDisplayName = 'Tenant One'
        m.OwnerEmail = 'owner@example.com'
        m.HiveId = 'h1'
        m.HiveDisplayName = 'Hive One'
    }

    public static ToLastStep(view: ProvisionWizardView): void
    {
        view.NextButton?.Press()
        view.NextButton?.Press()
    }
}

describe('ProvisionWizardView', () =>
{
    let previous: Application | null

    before(() =>
    {
        previous = Application.current
        const app = new Application()
        Application.current = app
        app.initialize({ theme: Pragmatic, scheme: PragmaticLight })
    })

    after(() =>
    {
        Application.current = previous
    })

    it('a full operator submits, sees both secrets, and Finish is blocked until both are confirmed', async () =>
    {
        const client = new FakeClient()
        let done = 0
        const view = new ProvisionWizardView(client as unknown as ControlPlaneClient, OperatorContext.FromWire('full'), () => { done++ })
        Fixtures.Fill(view)
        Fixtures.ToLastStep(view)
        assert.equal(view.Mode, WizardViewMode.Form)
        assert.ok(view.SubmitAct !== undefined)
        view.SubmitAct?.Press()
        await Fixtures.Tick()
        assert.equal(client.Calls, 1)
        assert.equal(view.Mode, WizardViewMode.Reveal)
        assert.equal(view.Reveals.length, 2)
        assert.equal(view.Reveals[0].Value, Fixtures.Password)
        assert.equal(view.Reveals[1].Value, Fixtures.Token)
        assert.equal(view.FinishAct?.Enabled, false)
        view.FinishAct?.Press()
        assert.equal(done, 0)
        view.Reveals[0].ConfirmButton.Press()
        view.FinishAct?.Press()
        assert.equal(done, 0)
        view.Reveals[1].ConfirmButton.Press()
        assert.equal(view.FinishAct?.Enabled, true)
        view.FinishAct?.Press()
        assert.equal(done, 1)
    })

    it('a second press while a provision is in flight does not provision twice', async () =>
    {
        const client = new FakeClient()
        let release: () => void = () => {}
        client.Gate = new Promise<void>(r => { release = r })
        const view = new ProvisionWizardView(client as unknown as ControlPlaneClient, OperatorContext.FromWire('full'), () => {})
        Fixtures.Fill(view)
        Fixtures.ToLastStep(view)
        view.SubmitAct?.Press()
        view.SubmitAct?.Press()
        assert.equal(view.SubmitAct?.Enabled, false)
        release()
        await Fixtures.Tick()
        assert.equal(client.Calls, 1)
        assert.equal(view.Mode, WizardViewMode.Reveal)
    })

    it('an observer cannot submit', async () =>
    {
        const client = new FakeClient()
        const view = new ProvisionWizardView(client as unknown as ControlPlaneClient, OperatorContext.FromWire('readonly'), () => {})
        Fixtures.Fill(view)
        Fixtures.ToLastStep(view)
        assert.equal(view.SubmitAct?.Enabled, false)
        view.SubmitAct?.Press()
        await Fixtures.Tick()
        assert.equal(client.Calls, 0)
        assert.equal(view.Mode, WizardViewMode.Form)
    })

    it('a server error shows the message and the rollback residue and stays in the form', async () =>
    {
        const client = new FakeClient()
        client.Error = new ApiError(500, 'provision failed', { rolledBack: ['client:c1'], residue: ['idp-realm:t1'] })
        const view = new ProvisionWizardView(client as unknown as ControlPlaneClient, OperatorContext.FromWire('full'), () => {})
        Fixtures.Fill(view)
        Fixtures.ToLastStep(view)
        view.SubmitAct?.Press()
        await Fixtures.Tick()
        assert.equal(view.Mode, WizardViewMode.Form)
        const texts = Fixtures.Texts(view).join('\n')
        assert.ok(texts.includes('provision failed'))
        assert.ok(texts.includes('idp-realm:t1'))
        assert.ok(texts.includes('client:c1'))
        assert.equal(view.Reveals.length, 0)
        assert.ok(!texts.includes(Fixtures.Password))
        assert.ok(!texts.includes(Fixtures.Token))
    })
})
