import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

/** Stateless HTTP primitives shared by the control-plane host and any other plane host (host/origin checks, JSON + static responses). */
export class PlaneHttp
{
    public static readonly HostHeaderPattern = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/
    public static readonly HostHeader = 'host'
    public static readonly OriginHeader = 'origin'
    public static readonly ContentType = 'Content-Type'
    public static readonly JsonType = 'application/json; charset=utf-8'
    public static readonly DefaultType = 'application/octet-stream'
    public static readonly MethodGet = 'GET'
    public static readonly MethodPost = 'POST'
    public static readonly MethodPut = 'PUT'
    public static readonly MethodDelete = 'DELETE'
    public static readonly StatusOk = 200
    public static readonly StatusNotFound = 404
    public static readonly NotFoundMessage = 'Not found'
    public static readonly RootPath = '/'
    public static readonly IndexFile = 'index.html'
    private static readonly CurrentDir = '.'
    public static readonly MimeTypes: ReadonlyMap<string, string> = new Map([
        ['.html', 'text/html; charset=utf-8'],
        ['.js', 'text/javascript; charset=utf-8'],
        ['.mjs', 'text/javascript; charset=utf-8'],
        ['.css', 'text/css; charset=utf-8'],
        ['.json', 'application/json; charset=utf-8'],
        ['.svg', 'image/svg+xml'],
        ['.png', 'image/png'],
        ['.ico', 'image/x-icon'],
        ['.map', 'application/json; charset=utf-8'],
        ['.txt', 'text/plain; charset=utf-8']
    ])

    /** The lowercased, port-stripped host of a Host header, or undefined when absent or unparseable. */
    public static HostName(hostHeader: string | undefined): string | undefined
    {
        const m = hostHeader === undefined ? null : PlaneHttp.HostHeaderPattern.exec(hostHeader)
        return m === null ? undefined : (m[1] as string).toLowerCase()
    }

    /** True when the request's Host header (port stripped, lowercased) is in the given set. */
    public static HostIn(req: IncomingMessage, allowed: ReadonlySet<string>): boolean
    {
        const h = PlaneHttp.HostName(req.headers[PlaneHttp.HostHeader] as string | undefined)
        return h !== undefined && allowed.has(h)
    }

    public static IsMutating(req: IncomingMessage): boolean
    {
        return req.method === PlaneHttp.MethodPost || req.method === PlaneHttp.MethodDelete || req.method === PlaneHttp.MethodPut
    }

    /** Absent Origin is allowed (non-browser / same-origin navigation); a present one's host must be in the given set. */
    public static OriginInHosts(req: IncomingMessage, allowed: ReadonlySet<string>): boolean
    {
        const origin = req.headers[PlaneHttp.OriginHeader]
        if (origin === undefined)
        {
            return true
        }
        const host = PlaneHttp.OriginHost(origin)
        return host !== undefined && allowed.has(host)
    }

    /** The lowercased host (port stripped) of an Origin header, or undefined when it does not parse. */
    public static OriginHost(origin: string): string | undefined
    {
        try
        {
            return new URL(origin).hostname.toLowerCase()
        }
        catch
        {
            return undefined
        }
    }

    public static async ServeStatic(req: IncomingMessage, res: ServerResponse, path: string, rootAbs: string): Promise<void>
    {
        if (req.method !== PlaneHttp.MethodGet)
        {
            PlaneHttp.WriteNotFound(res)
            return
        }
        let rel: string
        try
        {
            rel = decodeURIComponent(path)
        }
        catch
        {
            PlaneHttp.WriteNotFound(res)
            return
        }
        if (rel === PlaneHttp.RootPath)
        {
            rel = PlaneHttp.RootPath + PlaneHttp.IndexFile
        }
        const abs = resolve(rootAbs, PlaneHttp.CurrentDir + rel)
        if (!abs.startsWith(rootAbs + sep))
        {
            PlaneHttp.WriteNotFound(res)
            return
        }
        try
        {
            const data = await readFile(abs)
            const type = PlaneHttp.MimeTypes.get(extname(abs).toLowerCase()) ?? PlaneHttp.DefaultType
            res.writeHead(PlaneHttp.StatusOk, { [PlaneHttp.ContentType]: type })
            res.end(data)
        }
        catch
        {
            PlaneHttp.WriteNotFound(res)
        }
    }

    public static WriteNotFound(res: ServerResponse): void
    {
        PlaneHttp.WriteJson(res, PlaneHttp.StatusNotFound, { error: PlaneHttp.NotFoundMessage })
    }

    public static WriteJson(res: ServerResponse, status: number, body: unknown): void
    {
        res.writeHead(status, { [PlaneHttp.ContentType]: PlaneHttp.JsonType })
        res.end(JSON.stringify(body))
    }
}
