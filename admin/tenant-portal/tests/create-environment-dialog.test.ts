import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Button, ComboBox } from '@pragmatic-tech-ai/mural/framework'
import { Application, type Visual } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { CreateEnvironmentDialog } from '../src/create-environment-dialog.js'
import { TenantApiError } from '../src/tenant-api-client.js'
import { EnvStatus, EnvType, Template } from '../src/tenant-types.js'
import type { CreateEnvironmentParams, EnvironmentDto, IEnvironmentsSource } from '../src/tenant-types.js'

class FakeSource implements IEnvironmentsSource
{
    public readonly calls: CreateEnvironmentParams[] = []
    public failure: Error | undefined
    public gate: Promise<void> | undefined

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
        if (this.gate !== undefined)
        {
            return this.gate.then(() => FakeSource.Stub(params))
        }
        if (this.failure !== undefined)
        {
            return Promise.reject(this.failure)
        }
        return Promise.resolve(FakeSource.Stub(params))
    }
}

class Tree
{
    public static Collect<T>(root: Visual, type: new (...a: never[]) => T, out: T[] = []): T[]
    {
        if (root instanceof type)
        {
            out.push(root)
        }
        for (const c of (root as unknown as { visualChildren?: readonly Visual[] }).visualChildren ?? [])
        {
            Tree.Collect(c, type, out)
        }
        return out
    }

    public static Label(button: Button): string | undefined
    {
        return Tree.Collect(button, TextBlock)[0]?.Text
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

    it('drives the real ComboBox selection path', () =>
    {
        const d = new Harness().Make()
        const boxes = Tree.Collect(d, ComboBox)
        assert.equal(boxes.length, 2)
        boxes[0]!.SelectedItem = boxes[0]!.Items === undefined ? undefined : [...(boxes[0]!.Items as readonly unknown[])][2]
        boxes[1]!.SelectedItem = [...(boxes[1]!.Items as readonly unknown[])][0]
        assert.equal(d.SelectedTemplate, Template.RuntimePostgres)
        assert.equal(d.SelectedType, EnvType.Development)
    })

    it('disables Create and Cancel while a submit is in flight and blocks a second Submit', async () =>
    {
        const h = new Harness()
        let release: () => void = () => undefined
        h.source.gate = new Promise<void>(resolve => { release = resolve })
        const d = h.Make()
        d.SetName('training-q4')
        const first = d.Submit()
        assert.equal(d.CreateEnabled, false)
        await d.Submit()
        assert.equal(h.source.calls.length, 1)
        d.Cancel()
        assert.equal(d.Dismissed, false)
        release()
        await first
        assert.equal(h.created.length, 1)
        assert.equal(d.Dismissed, true)
    })

    it('accepts a 31-char name and rejects a 32-char name', () =>
    {
        const d = new Harness().Make()
        d.SetName('a' + 'b'.repeat(30))
        assert.equal(d.CreateEnabled, true)
        d.SetName('a' + 'b'.repeat(31))
        assert.equal(d.CreateEnabled, false)
        assert.match(d.Error ?? '', /lowercase letters/)
    })

    it('mirrors validity onto the rendered Create button', () =>
    {
        const d = new Harness().Make()
        const create = () => Tree.Collect(d, Button).filter(b => b.Command !== undefined && Tree.Label(b) === 'Create environment')[0]!
        d.SetName('training-q4')
        assert.equal(create().IsEnabled, true)
        d.SetName('ab')
        assert.equal(create().IsEnabled, false)
    })
})
