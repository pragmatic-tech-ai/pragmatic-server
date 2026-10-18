/** A promise-chain mutex: queued critical sections run one at a time, in arrival order. */
export class AsyncMutex
{
    private tail: Promise<unknown> = Promise.resolve()

    public Run<T>(section: () => Promise<T>): Promise<T>
    {
        const result = this.tail.then(section, section)
        this.tail = result.catch(() => undefined)
        return result
    }
}
