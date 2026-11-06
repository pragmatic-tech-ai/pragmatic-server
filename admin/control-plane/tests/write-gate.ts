/**
 * Wraps a store's file writes for a concurrency test: records each write's start and end in order (`start1`, `end1`, ...)
 * and holds the write that starts after Hold() until Release(). A test subclass's write hook calls Around(() => super...).
 */
export class WriteGate
{
    public static readonly StartTag = 'start'
    public static readonly EndTag = 'end'

    public readonly Events: string[] = []
    private held: Promise<void> | null = null
    private release: () => void = () => undefined
    private count = 0

    /** The event recorded when the n-th write starts. */
    public static Start(n: number): string
    {
        return `${WriteGate.StartTag}${n}`
    }

    /** The event recorded when the n-th write ends. */
    public static End(n: number): string
    {
        return `${WriteGate.EndTag}${n}`
    }

    /** Lets every pending promise continuation run. */
    public static Settle(): Promise<void>
    {
        return new Promise(resolve => setImmediate(resolve))
    }

    /** Arms the gate: the next write to start waits until Release(). */
    public Hold(): void
    {
        this.held = new Promise<void>(resolve => { this.release = resolve })
    }

    public Release(): void
    {
        this.release()
    }

    /** How many writes have started and not yet ended. */
    public get InFlight(): number
    {
        const started = this.Events.filter(e => e.startsWith(WriteGate.StartTag)).length
        const ended = this.Events.filter(e => e.startsWith(WriteGate.EndTag)).length
        return started - ended
    }

    public async Around(write: () => Promise<void>): Promise<void>
    {
        const n = ++this.count
        this.Events.push(WriteGate.Start(n))
        const held = this.held
        this.held = null
        if (held !== null)
        {
            await held
        }
        await write()
        this.Events.push(WriteGate.End(n))
    }
}
