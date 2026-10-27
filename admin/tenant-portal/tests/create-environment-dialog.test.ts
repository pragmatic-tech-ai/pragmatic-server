import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { CreateEnvironmentDialog } from '../src/create-environment-dialog.js'
import { TenantApiError } from '../src/tenant-api-client.js'
import { EnvStatus, EnvType, Template } from '../src/tenant-types.js'
import type { CreateEnvironmentParams, EnvironmentDto, IEnvironmentsSource } from '../src/tenant-types.js'

class FakeSource implements IEnvironmentsSource
{
    public readonly calls: CreateEnvironmentParams[] = []
    public failure: Error | undefined

    public static Stub(params: CreateEnvironmentParams): EnvironmentDto
    {
        return {
            name: params.name, template: params.template, type: params.type, environmentId: 'e1',
            hostPort: 1, status: EnvStatus.Running, createdAt: 'now', httpUrl: 'h', wsUrl: 'w',
        } as EnvironmentDto
    }

    public ListEnvironments(): Promise<EnvironmentDto[]> { return Promise.resolve([]) }
    public GetHealth(): Promise<never[]> { return Promise.resolve([]) }
    public StartEnvironment(): Promise<EnvironmentDto> { return Promise.reject(new Error('unused')) }
    public StopEnvironment(): Promise<EnvironmentDto> { return Promise.reject(new Error('unused')) }
    public RestartEnvironment(): Promise<EnvironmentDto> { return Promise.reject(new Error('unused')) }

    public CreateEnvironment(params: CreateEnvironmentParams): Promise<EnvironmentDto>
    {
        this.calls.push(params)
        if (this.failure !== undefined)
        {
            return Promise.reject(this.failure)
        }
        return Promise.resolve(FakeSource.Stub(params))
    }
}

class Harness
{
    public readonly source = new FakeSource()
    public readonly created: EnvironmentDto[] = []

    public Make(): CreateEnvironmentDialog
    {
        return new CreateEnvironmentDialog(this.source, ['existing'], env => { this.created.push(env) })
    }
}

describe('CreateEnvironmentDialog', () =>
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

    it('starts disabled with no error and the default selections', () =>
    {
        const d = new Harness().Make()
        assert.equal(d.Title, 'Create environment')
        assert.equal(d.CreateEnabled, false)
        assert.equal(d.Error, undefined)
        assert.equal(d.SelectedTemplate, Template.DevBlank)
        assert.equal(d.SelectedType, EnvType.Runtime)
    })

    it('reports a format error for short or uppercase names', () =>
    {
        const d = new Harness().Make()
        d.SetName('ab')
        assert.equal(d.CreateEnabled, false)
        assert.match(d.Error ?? '', /lowercase letters/)
        d.SetName('Valid')
        assert.equal(d.CreateEnabled, false)
        assert.match(d.Error ?? '', /lowercase letters/)
    })

    it('reports a duplicate for an existing name', () =>
    {
        const d = new Harness().Make()
        d.SetName('existing')
        assert.equal(d.CreateEnabled, false)
        assert.equal(d.Error, 'An environment with this name exists.')
    })

    it('enables Create for a valid unique name', () =>
    {
        const d = new Harness().Make()
        d.SetName('training-q4')
        assert.equal(d.CreateEnabled, true)
        assert.equal(d.Error, undefined)
    })

    it('changes template and type', () =>
    {
        const d = new Harness().Make()
        d.SetTemplate(Template.RuntimePostgres)
        d.SetType(EnvType.Development)
        assert.equal(d.SelectedTemplate, Template.RuntimePostgres)
        assert.equal(d.SelectedType, EnvType.Development)
    })

    it('submits exactly name/template/type, fires onCreated and dismisses', async () =>
    {
        const h = new Harness()
        const d = h.Make()
        d.SetName('training-q4')
        d.SetTemplate(Template.DemoContoso)
        await d.Submit()
        assert.deepEqual(h.source.calls, [{ name: 'training-q4', template: Template.DemoContoso, type: EnvType.Runtime }])
        assert.equal(h.created.length, 1)
        assert.equal(h.created[0]?.name, 'training-q4')
        assert.equal(d.Dismissed, true)
    })

    it('shows the duplicate message on 409 and does not fire onCreated', async () =>
    {
        const h = new Harness()
        h.source.failure = new TenantApiError(409, 'conflict')
        const d = h.Make()
        d.SetName('training-q4')
        await d.Submit()
        assert.equal(d.Error, 'An environment with this name exists.')
        assert.equal(h.created.length, 0)
        assert.equal(d.Dismissed, false)
        assert.equal(d.CreateEnabled, true)
    })

    it('shows a generic failure for other errors', async () =>
    {
        const h = new Harness()
        h.source.failure = new Error('boom')
        const d = h.Make()
        d.SetName('training-q4')
        await d.Submit()
        assert.match(d.Error ?? '', /Could not create/)
        assert.equal(h.created.length, 0)
    })
})
