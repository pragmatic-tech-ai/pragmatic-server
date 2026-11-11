import type { ISignal, ISubscription } from '@pragmatic-tech-ai/graph'
import { Signal } from '@pragmatic-tech-ai/todl-runtime'

/**
 * The change signal of an engine host (`IGraphEngineHost.Changed`): subscribers see the engine-side `ISignal` shape,
 * the host raises it after every applied upgrade or reopen. Shared by the dev and the environment host.
 */
export class EngineHostChanged implements ISignal<void>
{
    private readonly signal = new Signal<void>()

    public Subscribe(handler: (value: void) => void): ISubscription
    {
        return this.signal.subscribe(handler)
    }

    public Raise(): void
    {
        this.signal.emit(undefined)
    }
}
