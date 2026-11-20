/** jsonb columns as the stores read and write them: written as JSON text, read back parsed (a driver may hand either). */
export class SqlJson
{
    public static Write(value: unknown): string
    {
        return JSON.stringify(value);
    }

    public static Read(value: unknown): unknown
    {
        if (typeof value !== 'string')
        {
            return value;
        }
        try
        {
            return JSON.parse(value) as unknown;
        }
        catch
        {
            return undefined;
        }
    }

    /** A jsonb column holding an array of strings; anything else reads as empty. */
    public static Strings(value: unknown): string[]
    {
        const parsed = SqlJson.Read(value);
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    }

    /** A timestamptz column as a Date (drivers hand Date or text). */
    public static Date(value: unknown): Date
    {
        return value instanceof Date ? value : new Date(String(value));
    }
}
