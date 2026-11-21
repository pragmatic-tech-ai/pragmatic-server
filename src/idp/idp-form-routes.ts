import { HttpMethod, RouteAuth, RouteBody, type RequestContext, type RouteTable } from '@pragmatic-tech-ai/pragmatic-app-host';
import { RealmIssuer } from '@pragmatic-tech-ai/pragmatic-identity';
import type { ProtocolReply } from './token-endpoint.js';

/** One form-bodied OAuth endpoint (token, revocation): the realm, the decoded form and the Authorization header in. */
export interface IFormEndpoint
{
    Handle(realmId: string, form: URLSearchParams, authorization: string | undefined): Promise<ProtocolReply>;
}

/**
 * The realm sign-in service's form-bodied OAuth endpoints (`POST <issuer>/protocol/openid-connect/token` and `/revoke`,
 * `application/x-www-form-urlencoded` by RFC 6749 §3.2 and RFC 7009) as AppHost routes declaring a form body: the host's
 * whole pipeline applies (security headers, the allowed Host, the Origin guard, a non-form body 415, the body limit 413,
 * each refused in the host's own JSON shape); an endpoint's answer is JSON with `no-store`. Public: each endpoint
 * authenticates its client itself. The Origin guard refuses a cross-origin browser POST: today's clients are servers
 * (no Origin); a browser-side client would need an Origin opt-out on the route first.
 */
export class IdpFormRoutes
{
    private static readonly BodyLimit = 16 * 1024;
    private static readonly CacheControlHeader = 'Cache-Control';
    private static readonly PragmaHeader = 'Pragma';
    private static readonly NoStore = 'no-store';
    private static readonly NoCache = 'no-cache';

    /** `endpoints` by the path under the realm (e.g. RealmIssuer.TokenPath). */
    public constructor(private readonly endpoints: ReadonlyMap<string, IFormEndpoint>)
    {
    }

    public Register(routes: RouteTable): void
    {
        for (const [path, endpoint] of this.endpoints)
        {
            routes.Add({
                Method: HttpMethod.Post, Pattern: RealmIssuer.Pattern(path), Auth: RouteAuth.Public, Audited: false,
                Body: RouteBody.Form, BodyLimit: IdpFormRoutes.BodyLimit, Handler: ctx => IdpFormRoutes.Serve(ctx, endpoint),
            });
        }
    }

    private static async Serve(ctx: RequestContext, endpoint: IFormEndpoint): Promise<void>
    {
        const F = IdpFormRoutes;
        const form = await ctx.ReadForm();
        const reply = await endpoint.Handle(ctx.Param(RealmIssuer.RealmParam), form, ctx.Request.headers.authorization);
        ctx.Response.setHeader(F.CacheControlHeader, F.NoStore);
        ctx.Response.setHeader(F.PragmaHeader, F.NoCache);
        ctx.WriteJson(reply.Status, reply.Body);
    }
}
