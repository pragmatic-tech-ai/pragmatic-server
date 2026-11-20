import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { InternalApiCredential } from '@pragmatic-tech-ai/pragmatic-app-host'

/** Admin's internal API could not be used: unreachable, timed out, refused, or answered something malformed. Carries
 *  no response text from admin. */
export class InternalApiUnavailableError extends Error
{
    private static readonly ErrorName = 'InternalApiUnavailableError'
    private static readonly MessageText = 'admin internal API unavailable'

    public constructor()
    {
        super(InternalApiUnavailableError.MessageText)
        this.name = InternalApiUnavailableError.ErrorName
    }
}

/** The edge's client for admin's internal API: JSON POSTs with the internal bearer and a hard deadline. */
export class InternalApiClient
{
    public static readonly DefaultTimeoutMs = 5000
    private static readonly HttpsScheme = 'https:'
    private static readonly MethodPost = 'POST'
    private static readonly ContentTypeHeader = 'content-type'
    private static readonly ContentLengthHeader = 'content-length'
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly JsonType = 'application/json'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly Utf8 = 'utf8'
    private static readonly StatusOk = 200
    private static readonly MaxReplyBytes = 4 * 1048576

    private readonly base: URL

    public constructor(baseUrl: string, private readonly credential: InternalApiCredential, private readonly timeoutMs: number = InternalApiClient.DefaultTimeoutMs)
    {
        this.base = new URL(baseUrl)
    }

    public Post<T>(path: string, body: unknown): Promise<T>
    {
        const C = InternalApiClient
        const url = new URL(path, this.base)
        const payload = Buffer.from(JSON.stringify(body), C.Utf8)
        const send = url.protocol === C.HttpsScheme ? httpsRequest : httpRequest
        return new Promise<T>((resolve, reject) =>
        {
            const fail = (): void => reject(new InternalApiUnavailableError())
            const req = send(url, {
                method: C.MethodPost,
                timeout: this.timeoutMs,
                headers: {
                    [C.ContentTypeHeader]: C.JsonType,
                    [C.ContentLengthHeader]: String(payload.length),
                    [C.AuthorizationHeader]: C.BearerPrefix + this.credential.Bearer(),
                },
            }, res =>
            {
                const chunks: Buffer[] = []
                let size = 0
                res.on('data', (c: Buffer) =>
                {
                    size += c.length
                    if (size > C.MaxReplyBytes)
                    {
                        req.destroy()
                        fail()
                        return
                    }
                    chunks.push(c)
                })
                res.on('error', fail)
                res.on('end', () =>
                {
                    if (res.statusCode !== C.StatusOk)
                    {
                        fail()
                        return
                    }
                    try
                    {
                        resolve(JSON.parse(Buffer.concat(chunks).toString(C.Utf8)) as T)
                    }
                    catch
                    {
                        fail()
                    }
                })
            })
            // A hard deadline for the whole exchange, not only socket inactivity.
            const deadline = setTimeout(() => req.destroy(), this.timeoutMs)
            req.on('close', () => clearTimeout(deadline))
            req.on('timeout', () => req.destroy())
            req.on('error', fail)
            req.end(payload)
        })
    }
}
