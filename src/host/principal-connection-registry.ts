/** A live connection that can be force-closed when its principal's access is revoked. */
export interface IRevocableConnection
{
    Revoke(): void
}

/** Forces every live connection of a principal closed. */
export interface IPrincipalInvalidator
{
    InvalidatePrincipal(tenantId: string, principalId: string): void
}

/** Indexes live connections by (tenantId, principalId) so a revoke can tear them all down. */
export class PrincipalConnectionRegistry implements IPrincipalInvalidator
{
    private static readonly KeySeparator = '\u0000'

    private readonly byKey = new Map<string, Set<IRevocableConnection>>()
    private readonly keyOf = new Map<IRevocableConnection, string>()

    public Add(tenantId: string, principalId: string, handler: IRevocableConnection): void
    {
        const key = PrincipalConnectionRegistry.KeyFor(tenantId, principalId)
        let bucket = this.byKey.get(key)
        if (bucket === undefined)
        {
            bucket = new Set<IRevocableConnection>()
            this.byKey.set(key, bucket)
        }
        bucket.add(handler)
        this.keyOf.set(handler, key)
    }

    public Remove(handler: IRevocableConnection): void
    {
        const key = this.keyOf.get(handler)
        if (key === undefined)
        {
            return
        }
        this.keyOf.delete(handler)
        const bucket = this.byKey.get(key)
        if (bucket === undefined)
        {
            return
        }
        bucket.delete(handler)
        if (bucket.size === 0)
        {
            this.byKey.delete(key)
        }
    }

    public InvalidatePrincipal(tenantId: string, principalId: string): void
    {
        const bucket = this.byKey.get(PrincipalConnectionRegistry.KeyFor(tenantId, principalId))
        if (bucket === undefined)
        {
            return
        }
        // Snapshot first: Revoke() closes the socket, whose close callback calls Remove() and mutates this Set.
        const targets = [...bucket]
        for (const handler of targets)
        {
            handler.Revoke()
        }
    }

    private static KeyFor(tenantId: string, principalId: string): string
    {
        return `${tenantId}${PrincipalConnectionRegistry.KeySeparator}${principalId}`
    }
}
