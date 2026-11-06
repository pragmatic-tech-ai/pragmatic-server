/** Records what an endpoint wrote so a test can assert on status, headers and JSON body without a real socket. */
export class ResRecorder
{
    public status = 0
    public body = ''
    public headersSent = false
    public readonly headers: Record<string, string | number | string[]> = {}

    public setHeader(name: string, value: string | number | string[]): void
    {
        this.headers[name] = value
    }

    public writeHead(status: number, headers?: Record<string, string | number | string[]>): this
    {
        this.status = status
        if (headers !== undefined)
        {
            Object.assign(this.headers, headers)
        }
        this.headersSent = true
        return this
    }

    public end(body?: string): void
    {
        if (body !== undefined)
        {
            this.body = body
        }
    }

    /** The body parsed as JSON, typed as the caller asks (unknown by default). */
    public Json<T = unknown>(): T
    {
        return JSON.parse(this.body) as T
    }
}
