import type { IncomingMessage } from 'node:http'

/** Reads a request body as JSON with a hard size cap. Returns null on overflow or non-object JSON. */
export class RequestBody
{
    private static readonly Encoding = 'utf8'

    public static async ReadJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown> | null>
    {
        const chunks: Buffer[] = []
        let total = 0
        for await (const chunk of req)
        {
            const buffer = chunk as Buffer
            total += buffer.length
            if (total > maxBytes)
            {
                return null
            }
            chunks.push(buffer)
        }
        try
        {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString(RequestBody.Encoding))
            if (typeof parsed === 'object' && parsed !== null)
            {
                return parsed as Record<string, unknown>
            }
            return null
        }
        catch
        {
            return null
        }
    }
}
