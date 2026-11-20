import type { IncomingMessage, ServerResponse } from 'node:http';
import { BodyTooLargeError, JsonApi, type AppHost, type AppHostConfig } from '@pragmatic-tech-ai/pragmatic-app-host';
import { AppHostServer } from './app-host-server.js';
import { RealmIssuer } from './realm-issuer.js';
import type { ProtocolReply } from './token-endpoint.js';

/** One form-bodied OAuth endpoint (token, revocation): the realm, the decoded form and the Authorization header in. */
export interface IFormEndpoint
{
    Handle(realmId: string, form: URLSearchParams, authorization: string | undefined): Promise<ProtocolReply>;
}

/**
 * Serves the realm sign-in service's form-bodied OAuth endpoints (`POST <issuer>/protocol/openid-connect/token` and
 * `/revoke`, `application/x-www-form-urlencoded` by RFC 6749 §3.2 and RFC 7009) ahead of the AppHost pipeline, which
 * refuses every non-JSON body (gap G1 in the plan's Ledger). Taken off the host's node server's `request` event; every
 * other request goes to the host's own listeners unchanged. The same guards apply: security headers, the allowed Host,
 * a body limit; the answer is JSON with `no-store`.
 */
export class IdpFormRoutes
{
    private static readonly RequestEvent = 'request';
    private static readonly PostMethod = 'POST';
    private static readonly BaseUrl = 'http://localhost';
    private static readonly RootPath = '/';
    private static readonly PathSeparator = '/';
    private static readonly FormType = 'application/x-www-form-urlencoded';
    private static readonly ContentTypeHeader = 'content-type';
    private static readonly ParameterSeparator = ';';
    private static readonly BodyLimit = 16 * 1024;
    private static readonly RealmSegmentIndex = 2;
    private static readonly RealmPathSegments = 3;
    private static readonly ErrorField = 'error';
    private static readonly InvalidRequest = 'invalid_request';
    private static readonly ServerError = 'server_error';
    private static readonly ForbiddenHost = 'Forbidden host';
    private static readonly JsonType = 'application/json; charset=utf-8';
    private static readonly CacheControl = 'no-store';
    private static readonly NoCache = 'no-cache';
    private static readonly ContentTypeName = 'Content-Type';
    private static readonly CacheControlName = 'Cache-Control';
    private static readonly PragmaName = 'Pragma';
    private static readonly StatusBadRequest = 400;
    private static readonly StatusForbidden = 403;
    private static readonly StatusTooLarge = 413;
    private static readonly StatusServerError = 500;

    private constructor(private readonly config: AppHostConfig, private readonly endpoints: ReadonlyMap<string, IFormEndpoint>)
    {
    }

    /** Installs the endpoints (by the path under the realm, e.g. RealmIssuer.TokenPath) on a listening host. */
    public static Install(host: AppHost, config: AppHostConfig, endpoints: ReadonlyMap<string, IFormEndpoint>): void
    {
        const server = AppHostServer.Of(host);
        const routes = new IdpFormRoutes(config, endpoints);
        const hostListeners = server.listeners(IdpFormRoutes.RequestEvent) as ((req: IncomingMessage, res: ServerResponse) => void)[];
        server.removeAllListeners(IdpFormRoutes.RequestEvent);
        server.on(IdpFormRoutes.RequestEvent, (req: IncomingMessage, res: ServerResponse) =>
        {
            const match = routes.Match(req);
            if (match !== undefined)
            {
                void routes.Serve(req, res, match.RealmId, match.Endpoint);
                return;
            }
            for (const listener of hostListeners)
            {
                listener.call(server, req, res);
            }
        });
    }

    private Match(req: IncomingMessage): { RealmId: string; Endpoint: IFormEndpoint } | undefined
    {
        const F = IdpFormRoutes;
        if ((req.method ?? '').toUpperCase() !== F.PostMethod)
        {
            return undefined;
        }
        let path: string;
        try
        {
            path = new URL(req.url ?? F.RootPath, F.BaseUrl).pathname;
        }
        catch
        {
            return undefined;
        }
        const segments = path.split(F.PathSeparator);
        if (segments.length < F.RealmPathSegments + 1 || segments[1] !== RealmIssuer.RealmsSegment)
        {
            return undefined;
        }
        const rest = F.PathSeparator + segments.slice(F.RealmPathSegments).join(F.PathSeparator);
        const endpoint = this.endpoints.get(rest);
        if (endpoint === undefined)
        {
            return undefined;
        }
        try
        {
            return { RealmId: decodeURIComponent(segments[F.RealmSegmentIndex] ?? ''), Endpoint: endpoint };
        }
        catch
        {
            return undefined;
        }
    }

    private async Serve(req: IncomingMessage, res: ServerResponse, realmId: string, endpoint: IFormEndpoint): Promise<void>
    {
        const F = IdpFormRoutes;
        try
        {
            this.config.Security.Apply(res);
            if (!this.config.AllowedHosts.Allows(req))
            {
                JsonApi.Drain(req);
                F.Write(res, F.StatusForbidden, { [F.ErrorField]: F.ForbiddenHost });
                return;
            }
            const type = (req.headers[F.ContentTypeHeader] ?? '').split(F.ParameterSeparator)[0]?.trim().toLowerCase();
            if (type !== F.FormType)
            {
                JsonApi.Drain(req);
                F.Write(res, F.StatusBadRequest, { [F.ErrorField]: F.InvalidRequest });
                return;
            }
            const form = new URLSearchParams(await JsonApi.ReadText(req, F.BodyLimit));
            const reply = await endpoint.Handle(realmId, form, req.headers.authorization);
            F.Write(res, reply.Status, reply.Body);
        }
        catch (err)
        {
            if (!res.headersSent)
            {
                F.Write(res, err instanceof BodyTooLargeError ? F.StatusTooLarge : F.StatusServerError, { [F.ErrorField]: err instanceof BodyTooLargeError ? F.InvalidRequest : F.ServerError });
            }
            else
            {
                res.end();
            }
        }
    }

    private static Write(res: ServerResponse, status: number, body: unknown): void
    {
        const F = IdpFormRoutes;
        res.writeHead(status, { [F.ContentTypeName]: F.JsonType, [F.CacheControlName]: F.CacheControl, [F.PragmaName]: F.NoCache });
        res.end(JSON.stringify(body));
    }
}
