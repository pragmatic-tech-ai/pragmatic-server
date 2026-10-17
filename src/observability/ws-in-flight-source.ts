import type { IInFlightSource } from './drain-controller.js'

/** Aggregates in-flight RPC counts across live connection handlers, plus an optional HTTP in-flight source. */
export class WsInFlightSource implements IInFlightSource
{
    private readonly handlers: Iterable<{ InFlight(): number }>
    private readonly extra: IInFlightSource | undefined

    public constructor(handlers: Iterable<{ InFlight(): number }>, extra?: IInFlightSource)
    {
        this.handlers = handlers
        this.extra = extra
    }

    public InFlight(): number
    {
        let total = this.extra?.InFlight() ?? 0
        for (const handler of this.handlers)
        {
            total += handler.InFlight()
        }
        return total
    }
}
