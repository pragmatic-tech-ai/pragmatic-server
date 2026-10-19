import type { IncomingMessage, ServerResponse } from 'node:http'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { PragmaticAppManifestParser } from './pragmatic-app-manifest.js'
import type { PragmaticAppManifest } from './pragmatic-app-manifest.js'
import { PragmaticAppsRegistry } from './pragmatic-apps-registry.js'

/** The slice of a per-tenant server the endpoint needs: its applications storage. */
export interface IAppStorageSource
{
    AppsStorage(): IStorage
}

/** Resolves a tenant id to its server; the host registry satisfies this. Rejects for an unknown tenant. */
export interface IAppServerResolver
{
    ServerFor(tenantId: string): Promise<IAppStorageSource>
}

interface AppRoute
{
    tenant: string
    app: string
    tenantRaw: string
    appRaw: string
    rest: string
    needsSlash: boolean
}

/**
 * Serves a deployed app's SPA shell and UI bundle at `GET /app/<tenant>/<app>/...`, same-origin so the session cookie and
 * the app's own same-origin WebSocket reach this host. The shell never carries a tenant (the tenant is resolved from the
 * session cookie at WS auth); only the non-secret app name is injected. Only files the manifest lists (`ui.entry` and
 * `ui.assets`) are served, every path segment is validated, and anything else answers a bare 404.
 */
export class AppServingEndpoint
{
    public static readonly RoutePrefix = '/app/'
    private static readonly Separator = '/'
    private static readonly Empty = ''
    private static readonly UiDir = 'ui'
    private static readonly ManifestFile = 'application.json'
    private static readonly UnsafeSegmentPattern = /[\\:\0]/
    private static readonly AmpersandPattern = /&/g
    private static readonly QuotePattern = /"/g
    private static readonly LessThanPattern = /</g
    private static readonly AmpersandEntity = '&amp;'
    private static readonly QuoteEntity = '&quot;'
    private static readonly LessThanEntity = '&lt;'
    private static readonly ExtensionSeparator = '.'
    private static readonly QueryMarker = '?'
    private static readonly GetMethod = 'GET'
    private static readonly HeadMethod = 'HEAD'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly ContentLengthHeader = 'Content-Length'
    private static readonly CacheControlHeader = 'Cache-Control'
    private static readonly NoSniffHeader = 'X-Content-Type-Options'
    private static readonly NoSniffValue = 'nosniff'
    private static readonly LocationHeader = 'Location'
    private static readonly NoCache = 'no-cache'
    private static readonly AssetCache = 'public, max-age=300'
    private static readonly HeadMarker = '<head>'
    private static readonly MetaPrefix = '<meta name="pragmatic-app" content="'
    private static readonly MetaSuffix = '">'
    private static readonly Utf8 = 'utf8'
    private static readonly OkStatus = 200
    private static readonly RedirectStatus = 308
    private static readonly NotFoundStatus = 404
    private static readonly MethodNotAllowedStatus = 405
    private static readonly OctetStream = 'application/octet-stream'
    private static readonly ContentTypes: ReadonlyMap<string, string> = new Map([
        ['html', 'text/html; charset=utf-8'],
        ['htm', 'text/html; charset=utf-8'],
        ['js', 'text/javascript; charset=utf-8'],
        ['mjs', 'text/javascript; charset=utf-8'],
        ['css', 'text/css; charset=utf-8'],
        ['json', 'application/json; charset=utf-8'],
        ['map', 'application/json; charset=utf-8'],
        ['svg', 'image/svg+xml'],
        ['png', 'image/png'],
        ['jpg', 'image/jpeg'],
        ['jpeg', 'image/jpeg'],
        ['gif', 'image/gif'],
        ['webp', 'image/webp'],
        ['ico', 'image/x-icon'],
        ['woff', 'font/woff'],
        ['woff2', 'font/woff2'],
        ['txt', 'text/plain; charset=utf-8'],
        ['wasm', 'application/wasm'],
    ])

    private readonly servers: IAppServerResolver

    public constructor(servers: IAppServerResolver)
    {
        this.servers = servers
    }

    /** True when `path` belongs to this endpoint (the caller must not route it further). */
    public static Matches(path: string): boolean
    {
        return path.startsWith(AppServingEndpoint.RoutePrefix)
    }

    public async Handle(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const method = req.method ?? AppServingEndpoint.Empty
        if (method !== AppServingEndpoint.GetMethod && method !== AppServingEndpoint.HeadMethod)
        {
            this.Fail(res, AppServingEndpoint.MethodNotAllowedStatus)
            return
        }
        const route = AppServingEndpoint.ParseRoute(req.url ?? AppServingEndpoint.Empty)
        if (route === null)
        {
            this.Fail(res, AppServingEndpoint.NotFoundStatus)
            return
        }
        let manifest: PragmaticAppManifest
        let storage: IStorage
        try
        {
            storage = (await this.servers.ServerFor(route.tenant)).AppsStorage()
            const manifestPath = route.app + AppServingEndpoint.Separator + AppServingEndpoint.ManifestFile
            if (!await storage.Exists(manifestPath))
            {
                this.Fail(res, AppServingEndpoint.NotFoundStatus)
                return
            }
            manifest = PragmaticAppManifestParser.Parse(await storage.ReadText(manifestPath))
        }
        catch
        {
            this.Fail(res, AppServingEndpoint.NotFoundStatus)
            return
        }
        const ui = manifest.ui
        if (ui === undefined)
        {
            this.Fail(res, AppServingEndpoint.NotFoundStatus)
            return
        }
        if (route.needsSlash)
        {
            const location = AppServingEndpoint.RoutePrefix + route.tenantRaw + AppServingEndpoint.Separator + route.appRaw + AppServingEndpoint.Separator
            res.writeHead(AppServingEndpoint.RedirectStatus, { [AppServingEndpoint.LocationHeader]: location })
            res.end()
            return
        }
        const isAsset = route.rest !== AppServingEndpoint.Empty && route.rest !== ui.entry && ui.assets.includes(route.rest)
        const isShell = route.rest === AppServingEndpoint.Empty || route.rest === ui.entry
            || (!isAsset && !AppServingEndpoint.LastSegmentHasExtension(route.rest))
        if (!isAsset && !isShell)
        {
            this.Fail(res, AppServingEndpoint.NotFoundStatus)
            return
        }
        const file = isShell ? ui.entry : route.rest
        const uiPath = route.app + AppServingEndpoint.Separator + AppServingEndpoint.UiDir + AppServingEndpoint.Separator + file
        let bytes: Uint8Array
        try
        {
            if (!await storage.Exists(uiPath))
            {
                this.Fail(res, AppServingEndpoint.NotFoundStatus)
                return
            }
            bytes = await storage.ReadBytes(uiPath)
        }
        catch
        {
            this.Fail(res, AppServingEndpoint.NotFoundStatus)
            return
        }
        const body = isShell ? this.InjectAppName(bytes, manifest.name) : Buffer.from(bytes)
        res.writeHead(AppServingEndpoint.OkStatus, {
            [AppServingEndpoint.ContentTypeHeader]: AppServingEndpoint.ContentTypeOf(file),
            [AppServingEndpoint.ContentLengthHeader]: body.length,
            [AppServingEndpoint.CacheControlHeader]: isShell ? AppServingEndpoint.NoCache : AppServingEndpoint.AssetCache,
            [AppServingEndpoint.NoSniffHeader]: AppServingEndpoint.NoSniffValue,
        })
        res.end(method === AppServingEndpoint.HeadMethod ? undefined : body)
    }

    /** Adds only the (validated, non-secret) app name to the shell; never a tenant. */
    private InjectAppName(bytes: Uint8Array, appName: string): Buffer
    {
        const html = Buffer.from(bytes).toString(AppServingEndpoint.Utf8)
        const index = html.toLowerCase().indexOf(AppServingEndpoint.HeadMarker)
        if (index < 0)
        {
            return Buffer.from(bytes)
        }
        const at = index + AppServingEndpoint.HeadMarker.length
        const escaped = appName
            .replace(AppServingEndpoint.AmpersandPattern, AppServingEndpoint.AmpersandEntity)
            .replace(AppServingEndpoint.QuotePattern, AppServingEndpoint.QuoteEntity)
            .replace(AppServingEndpoint.LessThanPattern, AppServingEndpoint.LessThanEntity)
        const meta = AppServingEndpoint.MetaPrefix + escaped + AppServingEndpoint.MetaSuffix
        return Buffer.from(html.slice(0, at) + meta + html.slice(at), AppServingEndpoint.Utf8)
    }

    private Fail(res: ServerResponse, status: number): void
    {
        res.writeHead(status)
        res.end()
    }

    private static ContentTypeOf(file: string): string
    {
        const name = file.slice(file.lastIndexOf(AppServingEndpoint.Separator) + 1)
        const dot = name.lastIndexOf(AppServingEndpoint.ExtensionSeparator)
        const extension = dot < 0 ? AppServingEndpoint.Empty : name.slice(dot + 1).toLowerCase()
        return AppServingEndpoint.ContentTypes.get(extension) ?? AppServingEndpoint.OctetStream
    }

    private static LastSegmentHasExtension(rest: string): boolean
    {
        const last = rest.slice(rest.lastIndexOf(AppServingEndpoint.Separator) + 1)
        return last.includes(AppServingEndpoint.ExtensionSeparator)
    }

    /**
     * Splits the RAW request path (before URL normalisation could collapse `..`) into tenant, app and remainder.
     * Every segment is percent-decoded once and must be a safe name; any unsafe or traversal segment yields null.
     * The only empty segment allowed is a trailing slash.
     */
    private static ParseRoute(rawUrl: string): AppRoute | null
    {
        const queryAt = rawUrl.indexOf(AppServingEndpoint.QueryMarker)
        const rawPath = queryAt < 0 ? rawUrl : rawUrl.slice(0, queryAt)
        if (!rawPath.startsWith(AppServingEndpoint.RoutePrefix))
        {
            return null
        }
        const parts = rawPath.slice(AppServingEndpoint.RoutePrefix.length).split(AppServingEndpoint.Separator)
        if (parts.length < 2)
        {
            return null
        }
        const decoded: string[] = []
        for (let i = 0; i < parts.length; i++)
        {
            if (i >= 2 && i === parts.length - 1 && parts[i] === AppServingEndpoint.Empty)
            {
                continue
            }
            const segment = AppServingEndpoint.DecodeSegment(parts[i]!)
            if (segment === null)
            {
                return null
            }
            decoded.push(segment)
        }
        return {
            tenant: decoded[0]!,
            app: decoded[1]!,
            tenantRaw: parts[0]!,
            appRaw: parts[1]!,
            rest: decoded.slice(2).join(AppServingEndpoint.Separator),
            needsSlash: parts.length === 2,
        }
    }

    private static DecodeSegment(raw: string): string | null
    {
        let value: string
        try
        {
            value = decodeURIComponent(raw)
        }
        catch
        {
            return null
        }
        if (AppServingEndpoint.UnsafeSegmentPattern.test(value))
        {
            return null
        }
        try
        {
            PragmaticAppsRegistry.AssertValidName(value)
        }
        catch
        {
            return null
        }
        return value
    }
}
