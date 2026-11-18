/**
 * The solution a connection's writes and contributes are attributed to. One per connection, so two
 * connections can author different solutions at once; it is decoupled from the environment-wide
 * ActiveSolution switch. Until a connection selects explicitly it follows the environment's current solution.
 */
export class AuthoringTarget
{
    private selected: string | undefined

    public constructor(private readonly fallback: () => string | undefined)
    {
    }

    public get SolutionId(): string | undefined
    {
        return this.selected ?? this.fallback()
    }

    /** The explicitly selected solution, or undefined while the connection still follows the environment. */
    public get Selected(): string | undefined
    {
        return this.selected
    }

    public Select(id: string): void
    {
        this.selected = id
    }
}
