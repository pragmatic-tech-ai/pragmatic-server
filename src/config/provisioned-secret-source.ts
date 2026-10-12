/** A read-only lookup of provisioned secret values, keyed by the ref strings used in tenant config. */
export interface IProvisionedSecretSource
{
    Lookup(reference: string): string | null
}

/** In-memory provisioned-secret source parsed from a JSON object of ref -> value (all values strings). */
export class ProvisionedSecretSource implements IProvisionedSecretSource
{
    private static readonly NotJsonError = 'provisioned secrets file is not valid JSON'
    private static readonly InvalidShapeError = 'provisioned secrets file has an invalid shape'

    private readonly entries: ReadonlyMap<string, string>

    private constructor(entries: ReadonlyMap<string, string>)
    {
        this.entries = entries
    }

    public static FromText(json: string): ProvisionedSecretSource
    {
        let parsed: unknown
        try
        {
            parsed = JSON.parse(json)
        }
        catch
        {
            throw new Error(ProvisionedSecretSource.NotJsonError)
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        {
            throw new Error(ProvisionedSecretSource.InvalidShapeError)
        }
        const entries = new Map<string, string>()
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>))
        {
            if (typeof value !== 'string')
            {
                throw new Error(ProvisionedSecretSource.InvalidShapeError)
            }
            entries.set(key, value)
        }
        return new ProvisionedSecretSource(entries)
    }

    public Lookup(reference: string): string | null
    {
        if (reference.length === 0)
        {
            return null
        }
        return this.entries.get(reference) ?? null
    }
}
