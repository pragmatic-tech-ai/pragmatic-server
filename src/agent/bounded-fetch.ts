/**
 * fetch with ONE deadline covering both the response headers and the body read, so a
 * server that stalls mid-body rejects (the loop's catch backs off) instead of hanging the
 * single-threaded loop.
 */
export class BoundedFetch
{
    private static readonly TimeoutMessage = 'registry request timed out after '
    private static readonly Millis = ' ms'

    private constructor()
    {
    }

    public static async Run<T>(
        url: string,
        init: RequestInit,
        timeoutMs: number,
        consume: (response: Response) => Promise<T>,
        fetchImpl: typeof fetch = fetch): Promise<T>
    {
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        const deadline = new Promise<never>((_, reject) =>
        {
            timer = setTimeout(() =>
            {
                controller.abort()
                reject(new Error(BoundedFetch.TimeoutMessage + timeoutMs + BoundedFetch.Millis))
            }, timeoutMs)
        })
        try
        {
            const work = fetchImpl(url, { ...init, signal: controller.signal }).then(consume)
            work.catch(() => undefined)
            return await Promise.race([work, deadline])
        }
        finally
        {
            clearTimeout(timer)
        }
    }
}
