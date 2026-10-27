import { StackPanel } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import {
    DeniedStateConfig, DeniedStatePanel, EmptyStateConfig, EmptyStatePanel,
    ErrorStateConfig, ErrorStatePanel, SkeletonKind, SkeletonPanel,
} from './state-panels.js'

export enum ScreenState
{
    Loading,
    Empty,
    Error,
    Denied,
    Populated,
}

export interface ScreenHostInputs
{
    loading: boolean
    allowed: boolean
    isEmpty: boolean
    error: boolean
    skeleton?: SkeletonKind
    empty?: EmptyStateConfig
    errorConfig?: ErrorStateConfig
    denied?: DeniedStateConfig
    content?: Visual | (() => Visual)
}

// Resolves to exactly one state: loading > denied > error > empty > populated.
export class ScreenHost extends StackPanel
{
    private static readonly EmptyTitleFallback = ''
    private static readonly DefaultEmpty: EmptyStateConfig = { title: ScreenHost.EmptyTitleFallback }

    private inputs: ScreenHostInputs
    private state: ScreenState

    public constructor(inputs: ScreenHostInputs)
    {
        super()
        this.inputs = inputs
        this.state = ScreenHost.Resolve(inputs)
        this.Build()
    }

    public get State(): ScreenState
    {
        return this.state
    }

    public Update(inputs: ScreenHostInputs): void
    {
        this.inputs = inputs
        this.state = ScreenHost.Resolve(inputs)
        this.Build()
    }

    public static Resolve(inputs: ScreenHostInputs): ScreenState
    {
        if (inputs.loading)
        {
            return ScreenState.Loading
        }
        if (!inputs.allowed)
        {
            return ScreenState.Denied
        }
        if (inputs.error)
        {
            return ScreenState.Error
        }
        if (inputs.isEmpty)
        {
            return ScreenState.Empty
        }
        return ScreenState.Populated
    }

    private Build(): void
    {
        for (const child of [...this.Children])
        {
            this.RemoveChild(child)
        }
        const view = this.View()
        if (view !== undefined)
        {
            this.AddChild(view)
        }
    }

    private View(): Visual | undefined
    {
        switch (this.state)
        {
            case ScreenState.Loading:
                return new SkeletonPanel(this.inputs.skeleton)
            case ScreenState.Denied:
                return new DeniedStatePanel(this.inputs.denied)
            case ScreenState.Error:
                return new ErrorStatePanel(this.inputs.errorConfig)
            case ScreenState.Empty:
                return new EmptyStatePanel(this.inputs.empty ?? ScreenHost.DefaultEmpty)
            case ScreenState.Populated:
            {
                const content = this.inputs.content
                return typeof content === 'function' ? content() : content
            }
        }
    }
}
