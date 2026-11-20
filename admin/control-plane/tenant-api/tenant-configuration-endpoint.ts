import { HttpMethod, HttpProblem, RouteAuth, type RequestContext, type RouteTable } from '@pragmatic-tech-ai/pragmatic-app-host'
import { ConfigurationHeadMovedError, ConfigurationRejectedError, ConfigurationRequestError } from '@pragmatic-tech-ai/pragmatic-configuration'
import { ConfigurationNoTargetError, ConfigurationNotFoundError, type ConfigurationService } from '../configuration/configuration-service.js'
import { ConfigurationApplyUnavailableError } from '../configuration/kube-configuration-applier.js'
import { TenantRoles } from '../tenant-auth/tenant-roles.js'
import { TenantSessionClaims, type TenantSession } from '../tenant-auth/tenant-sessions.js'

/**
 * The configuration repository's routes on the tenant API (`/tenant-api/configuration/*`), scoped to the session's tenant
 * (its realm). Reads are open to any session of the tenant; saving and applying a version need the tenant role `admin`.
 * A document that does not validate is 422 with the paths and fixed messages (never the values); a save based on a
 * version that is no longer the head is 409 with the head; an unknown component, version or environment 404; a component
 * with no target there 409; a console outside its cluster 503.
 */
export class TenantConfigurationEndpoint
{
    private static readonly ComponentsPath = '/tenant-api/configuration/components'
    private static readonly ComponentPath = '/tenant-api/configuration/components/:component'
    private static readonly VersionsPath = '/tenant-api/configuration/components/:component/versions'
    private static readonly VersionPath = '/tenant-api/configuration/components/:component/versions/:version'
    private static readonly ApplyPath = '/tenant-api/configuration/components/:component/versions/:version/apply'
    private static readonly DiffPath = '/tenant-api/configuration/components/:component/diff'
    private static readonly ComponentParam = 'component'
    private static readonly VersionParam = 'version'
    private static readonly FromParam = 'from'
    private static readonly ToParam = 'to'
    private static readonly BasedOnField = 'basedOn'
    private static readonly DocumentField = 'document'
    private static readonly CommentField = 'comment'
    private static readonly EnvironmentField = 'environment'
    private static readonly ErrorField = 'error'
    private static readonly ErrorsField = 'errors'
    private static readonly HeadField = 'head'
    private static readonly NoComment = ''
    /** A configuration document is a small JSON object; 64 KiB is far above any real one. */
    public static readonly MaxBodyBytes = 64 * 1024
    private static readonly StatusOk = 200
    private static readonly StatusCreated = 201
    private static readonly StatusBadRequest = 400
    private static readonly StatusUnauthorized = 401
    private static readonly StatusNotFound = 404
    private static readonly StatusConflict = 409
    private static readonly StatusUnprocessable = 422
    private static readonly StatusUnavailable = 503
    private static readonly UnauthenticatedMessage = 'Not signed in'
    private static readonly SaveFieldsMessage = 'basedOn (an integer, 0 for the first version), document (an object) and an optional comment (a string) are required'
    private static readonly ApplyFieldsMessage = 'environment (a non-empty string) is required'
    private static readonly DiffParamsMessage = 'from and to (version numbers; from 0 is the empty document) are required'
    private static readonly RejectedMessage = 'The configuration does not fit the component version it runs with.'
    private static readonly HeadMovedMessage = 'Another version was saved meanwhile: start again from the newest version.'
    private static readonly IntegerPattern = /^(0|[1-9][0-9]*)$/

    public constructor(private readonly service: ConfigurationService)
    {
    }

    public Register(table: RouteTable): void
    {
        const C = TenantConfigurationEndpoint
        const admin = { Role: TenantRoles.Admin }
        const read = (pattern: string, run: (ctx: RequestContext, s: TenantSession) => Promise<void>): void =>
        {
            table.Add({ Method: HttpMethod.Get, Pattern: pattern, Auth: RouteAuth.Session, Handler: ctx => this.Run(ctx, run) })
        }
        read(C.ComponentsPath, async (ctx, s) => ctx.WriteJson(C.StatusOk, await this.service.List(s.tenantId)))
        read(C.ComponentPath, async (ctx, s) => ctx.WriteJson(C.StatusOk, await this.service.Component(s.tenantId, ctx.Param(C.ComponentParam))))
        read(C.VersionPath, async (ctx, s) => ctx.WriteJson(C.StatusOk, await this.service.Version(s.tenantId, ctx.Param(C.ComponentParam), C.VersionOf(ctx))))
        read(C.DiffPath, (ctx, s) => this.Diff(ctx, s))
        table.Add({ Method: HttpMethod.Post, Pattern: C.VersionsPath, Auth: RouteAuth.Session, ...admin, BodyLimit: C.MaxBodyBytes, Handler: ctx => this.Run(ctx, (c, s) => this.Save(c, s)) })
        table.Add({ Method: HttpMethod.Post, Pattern: C.ApplyPath, Auth: RouteAuth.Session, ...admin, Handler: ctx => this.Run(ctx, (c, s) => this.Apply(c, s)) })
    }

    /** Runs a route with the session's tenant view and answers the service's refusals with their statuses. */
    private async Run(ctx: RequestContext, run: (ctx: RequestContext, session: TenantSession) => Promise<void>): Promise<void>
    {
        const C = TenantConfigurationEndpoint
        const session = TenantSessionClaims.ViewOf(ctx.RequireSession())
        if (session === undefined)
        {
            throw new HttpProblem(C.StatusUnauthorized, C.UnauthenticatedMessage)
        }
        try
        {
            await run(ctx, session)
        }
        catch (err)
        {
            C.WriteRefusal(ctx, err)
        }
    }

    private async Save(ctx: RequestContext, session: TenantSession): Promise<void>
    {
        const C = TenantConfigurationEndpoint
        const body = await ctx.ReadJsonObject()
        const basedOn = body[C.BasedOnField]
        const document = body[C.DocumentField]
        const comment = body[C.CommentField] ?? C.NoComment
        if (typeof basedOn !== 'number' || !Number.isSafeInteger(basedOn) || basedOn < 0 || typeof document !== 'object' || document === null || Array.isArray(document) || typeof comment !== 'string')
        {
            ctx.WriteJson(C.StatusBadRequest, { [C.ErrorField]: C.SaveFieldsMessage })
            return
        }
        ctx.NoteAudit(ctx.Param(C.ComponentParam))
        ctx.WriteJson(C.StatusCreated, await this.service.Save(session.tenantId, ctx.Param(C.ComponentParam), basedOn, document, session.principalId, comment))
    }

    private async Apply(ctx: RequestContext, session: TenantSession): Promise<void>
    {
        const C = TenantConfigurationEndpoint
        const body = await ctx.ReadJsonObject()
        const environment = body[C.EnvironmentField]
        if (typeof environment !== 'string' || environment.length === 0)
        {
            ctx.WriteJson(C.StatusBadRequest, { [C.ErrorField]: C.ApplyFieldsMessage })
            return
        }
        ctx.NoteAudit(environment)
        ctx.WriteJson(C.StatusOk, await this.service.Apply(session.tenantId, ctx.Param(C.ComponentParam), C.VersionOf(ctx), environment, session.principalId))
    }

    private async Diff(ctx: RequestContext, session: TenantSession): Promise<void>
    {
        const C = TenantConfigurationEndpoint
        const from = ctx.Query.get(C.FromParam)
        const to = ctx.Query.get(C.ToParam)
        if (from === null || to === null || !C.IntegerPattern.test(from) || !C.IntegerPattern.test(to))
        {
            ctx.WriteJson(C.StatusBadRequest, { [C.ErrorField]: C.DiffParamsMessage })
            return
        }
        ctx.WriteJson(C.StatusOk, await this.service.Diff(session.tenantId, ctx.Param(C.ComponentParam), Number(from), Number(to)))
    }

    /** The route's version number; not a number reads as no such version (404). */
    private static VersionOf(ctx: RequestContext): number
    {
        const raw = ctx.Param(TenantConfigurationEndpoint.VersionParam)
        return TenantConfigurationEndpoint.IntegerPattern.test(raw) ? Number(raw) : -1
    }

    private static WriteRefusal(ctx: RequestContext, err: unknown): void
    {
        const C = TenantConfigurationEndpoint
        if (err instanceof ConfigurationRejectedError)
        {
            ctx.WriteJson(C.StatusUnprocessable, { [C.ErrorField]: C.RejectedMessage, [C.ErrorsField]: err.Errors.map(e => ({ path: e.Path, message: e.Message })) })
            return
        }
        if (err instanceof ConfigurationHeadMovedError)
        {
            ctx.WriteJson(C.StatusConflict, { [C.ErrorField]: C.HeadMovedMessage, [C.HeadField]: err.Head })
            return
        }
        if (err instanceof ConfigurationRequestError)
        {
            ctx.WriteJson(C.StatusBadRequest, { [C.ErrorField]: C.SaveFieldsMessage })
            return
        }
        if (err instanceof ConfigurationNotFoundError)
        {
            ctx.WriteJson(C.StatusNotFound, { [C.ErrorField]: err.message })
            return
        }
        if (err instanceof ConfigurationNoTargetError)
        {
            ctx.WriteJson(C.StatusConflict, { [C.ErrorField]: err.message })
            return
        }
        if (err instanceof ConfigurationApplyUnavailableError)
        {
            ctx.WriteJson(C.StatusUnavailable, { [C.ErrorField]: err.message })
            return
        }
        throw err
    }
}
