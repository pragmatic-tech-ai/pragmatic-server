import type { IncomingMessage, ServerResponse } from 'node:http'
import { HttpMethod, HttpProblem, RouteAuth, type RequestContext, type RouteTable } from '@pragmatic-tech-ai/pragmatic-app-host'
import type { IEnvironmentService, MakerTokenDto } from '../control-plane-host.js'
import { EnvironmentDtoMapper } from '../environment-dto.js'
import { TenantAdminCapabilities } from './tenant-admin-capabilities.js'
import { TenantProfileMapper, type TenantProfileDto } from './tenant-profile-dto.js'
import { HiveDtoMapper } from './hive-dto.js'
import { HiveHealthProducer } from '../hive-health-producer.js'
import type { EnvironmentPlacement } from '../environment-placement.js'
import type { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import { RolloutAdoptionRefusedError, RolloutUnavailableError, type IRolloutClient } from './rollout-client.js'
import type { ITenantDirectory } from './tenant-directory.js'
import { DomainNotClaimedError, DomainVerificationUnavailableError, DomainVerifyThrottledError, EmailDomainsNotEditableError, TenantEmailDomainsLimits, type ITenantEmailDomains, type TenantEmailDomainsView } from './tenant-email-domains.js'
import { InvalidEmailDomainError } from '../email-domain-policy.js'
import type { EnvironmentRecord } from '../environment-record.js'
import { ChannelNotSubscribedError, ManifestNotGatedError, ManifestWithdrawnError, ReleaseNotRunnableYetError, TenantOnHoldError, UnknownHiveError, UnknownManifestError, VersionBelowFloorError } from '../rollout-errors.js'
import { TenantRoles } from '../tenant-auth/tenant-roles.js'
import { TenantSessionClaims, type TenantSession } from '../tenant-auth/tenant-sessions.js'
import { AdminProxyError, AdminProxyErrorKind } from '../admin-proxy.js'
import { CreateFailedError, EnvironmentExistsError, EnvironmentNotDevelopmentError, EnvironmentNotFoundError, EnvironmentNotRuntimeError } from '../environment-service.js'
import { EnvType, Template } from '../environment-record.js'
import { UnsupportedBackendError } from '../hive-orchestrator.js'
import { PlaneHttp } from '../plane-http.js'
import { TenantGraphAccess } from './tenant-graph-access.js'
import { TenantSignInInHiveError } from '../tenant-idp-mode.js'
import type { CreateAccountParams, GrantMutationDto, IdentityConfigDto, IssueTokenParams, SecurityModelDto } from '@pragmatic-tech-ai/pragmatic-protocol'

/** A graph request's final status and the graph name its audit note carries ('' when a POST body had no usable name). */
type GraphOutcome = { status: number; graph: string }

/** The lifecycle action a tenant may request against its own environment; the values byte-match the URL path segments. */
export enum TenantEnvAction
{
    Start = 'start',
    Stop = 'stop',
    Restart = 'restart'
}

/** Which roles a tenant API route admits (the old capabilities): any session (reads), the environments, or the tenant admin. */
export enum TenantApiAccess
{
    /** Reads: any session of the host's tenant. */
    Read = 'read',
    /** envs / adopt: the tenant role admin or the application role environment-admin. */
    Environments = 'environments',
    /** access / settings: the tenant role admin. */
    Admin = 'admin',
}

/** The per-environment identity-admin reads under .../environments/NAME/admin/LEAF. */
enum AdminReadLeaf
{
    Snapshot = 'snapshot',
    Config = 'config',
    Tokens = 'tokens',
    SecurityModel = 'security-model',
    SecurityCatalog = 'security-catalog',
    SecurityChanges = 'security-changes',
}

/**
 * The tenant-plane API (`/tenant-api/*`), declared on the host's route table. Every route is scoped to the caller's own
 * tenant, taken ONLY from the session's `tenant` claim (which the gate matched to the request's host) - never from a
 * query string or body - so a tenant-A session can neither read nor mutate tenant-B's hives, environments, manifests,
 * rollout or health. The `:id`/`:name` routes answer 404 (not 403) unless the resource is owned by the session's tenant
 * (including when it does not exist), so existence is never revealed and no cross-tenant action is ever reached. The
 * host authorizes each route by its roles (TenantApiAccess) before the handler runs: reads are open to any session of
 * the tenant, environment mutations need `admin` or `environment-admin`, access and settings mutations `admin`.
 * Mutation errors from the rollout engine are mapped to fixed generic bodies: the version id and other internals never
 * reach the wire.
 */
export class TenantApiEndpoint
{
    public static readonly Prefix = '/tenant-api/'
    private static readonly ProfilePath = '/tenant-api/profile'
    private static readonly HivesPath = '/tenant-api/hives'
    private static readonly EnvironmentsPath = '/tenant-api/environments'
    private static readonly ManifestsPath = '/tenant-api/manifests'
    private static readonly HiveRolloutPath = '/tenant-api/hives/:id/rollout'
    private static readonly HiveHealthPath = '/tenant-api/hives/:id/health'
    private static readonly HiveLedgerPath = '/tenant-api/hives/:id/ledger'
    private static readonly HiveTargetPath = '/tenant-api/hives/:id/target'
    private static readonly EnvPath = '/tenant-api/environments/:name'
    private static readonly EnvActionPathPrefix = '/tenant-api/environments/:name/'
    private static readonly AdminPathPrefix = '/tenant-api/environments/:name/admin/'
    private static readonly AccountsPath = '/tenant-api/environments/:name/admin/accounts'
    private static readonly AccountPath = '/tenant-api/environments/:name/admin/accounts/:principal'
    private static readonly GrantsPath = '/tenant-api/environments/:name/admin/grants'
    private static readonly TokensPath = '/tenant-api/environments/:name/admin/tokens'
    private static readonly SecurityModelPath = '/tenant-api/environments/:name/admin/security-model'
    private static readonly ConfigPath = '/tenant-api/environments/:name/admin/config'
    private static readonly TeamMembersPath = '/tenant-api/environments/:name/admin/team-members/:team'
    private static readonly MakerTokenPath = '/tenant-api/environments/:name/maker-token'
    private static readonly AppReaderPath = '/tenant-api/environments/:name/app-reader-grant'
    private static readonly GraphsPath = '/tenant-api/environments/:name/graphs'
    private static readonly GraphPath = '/tenant-api/environments/:name/graphs/:graph'
    /** GET reads, PUT (tenant admin) replaces the tenant's email domains; a route only when the endpoint has an email-domain store. */
    private static readonly EmailDomainsPath = '/tenant-api/settings/email-domains'
    /** POST (tenant admin) checks one claimed domain's DNS TXT record now. */
    private static readonly EmailDomainsVerifyPath = '/tenant-api/settings/email-domains/verify'
    private static readonly IdParam = 'id'
    private static readonly NameParam = 'name'
    private static readonly PrincipalParam = 'principal'
    private static readonly TeamParam = 'team'
    private static readonly GraphParam = 'graph'
    private static readonly LedgerLimit = 200
    private static readonly SettingsCapability = 'settings'
    private static readonly DomainsKey = 'domains'
    private static readonly DomainKey = 'domain'
    private static readonly DescriptionKey = 'description'
    private static readonly GraphFailedLogPrefix = '[tenant-api] graph operation failed:'
    private static readonly MethodGet = 'GET'
    private static readonly MethodPost = 'POST'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly JsonType = 'application/json; charset=utf-8'
    private static readonly VersionKey = 'version'
    private static readonly Utf8 = 'utf8'
    private static readonly DataEvent = 'data'
    private static readonly EndEvent = 'end'
    private static readonly ErrorEvent = 'error'
    /** A target-selection body carries only { version }; nothing legitimate is larger, so anything bigger is rejected as invalid. */
    public static readonly MaxBodyBytes = 4096
    private static readonly StatusOk = 200
    private static readonly StatusCreated = 201
    private static readonly StatusNoContent = 204
    private static readonly StatusBadRequest = 400
    private static readonly StatusUnauthorized = 401
    private static readonly StatusNotFound = 404
    private static readonly StatusConflict = 409
    private static readonly StatusTooManyRequests = 429
    private static readonly StatusInternal = 500
    private static readonly StatusUnavailable = 503
    private static readonly NotFoundMessage = PlaneHttp.NotFoundMessage
    private static readonly UnauthenticatedMessage = 'Not signed in'
    private static readonly BadJsonMessage = 'Request body must be valid JSON'
    private static readonly BodyObjectMessage = 'Request body must be a JSON object'
    private static readonly VersionRequiredMessage = 'version (non-empty string) is required'
    /** The one generic body for a not-gated target: no version id, no engine message, nothing that reveals what was asked for. */
    private static readonly TargetUnavailableMessage = 'Requested version is not available for this hive'
    private static readonly ErrorKey = 'error'
    private static readonly OkKey = 'ok'
    private static readonly CacheControlHeader = 'Cache-Control'
    private static readonly NoStore = 'no-store'
    private static readonly TokenIssueFieldsMessage = 'principalId (non-empty string), scopes (non-empty string array) and expiresInSeconds (positive integer or null) are required'
    private static readonly TokenRefMessage = 'tokenRef (non-empty string) is required'
    private static readonly AccountFieldsMessage = 'email, principalId and password (non-empty strings) are required'
    private static readonly GrantFieldsMessage = 'subject and role (strings) are required'
    private static readonly SecurityModelFieldMessage = 'securityModel (object) is required'
    private static readonly ConfigFieldsMessage = 'packId and delegationDepth (strings) are required'
    /** Fixed generic bodies for identity-admin engine failures: the inner error text (hosts, credentials) never reaches the wire. */
    private static readonly IdentityUnavailableMessage = 'Identity service is unavailable'
    private static readonly IdentityConflictMessage = 'The change conflicts with the environment identity rules'
    private static readonly IdentityInvalidMessage = 'The identity request was rejected as invalid'
    private static readonly IdentityFailedMessage = 'The identity operation failed'
    private static readonly WrongEnvKindMessage = 'The operation is not available for this environment type'
    private static readonly NameKey = 'name'
    private static readonly TemplateKey = 'template'
    private static readonly TypeKey = 'type'
    private static readonly CreateFieldsMessage = 'name (non-empty string), template and type (known values) are required'
    /** Fixed generic bodies for create failures: the inner error text (names, hosts, backends) never reaches the wire. */
    private static readonly NoHiveMessage = 'The tenant has no hive to create an environment in'
    private static readonly CreateExistsMessage = 'An environment with that name already exists'
    private static readonly CreateUnsupportedMessage = 'The hive backend does not support this operation'
    private static readonly CreateFailedMessage = 'The environment could not be created'
    private static readonly SentenceEnd = '.'
    private static readonly NoDetail = ''
    private static readonly SentenceSeparator = ' '
    private static readonly CreateFailedRecordedMessage = 'It is listed as failed; delete it before reusing the name.'
    private static readonly CreateFailedLogPrefix = '[tenant-api] environment create failed:'
    private static readonly Roles: ReadonlyMap<TenantApiAccess, { Role?: string; AppRole?: string }> = new Map([
        [TenantApiAccess.Read, {}],
        [TenantApiAccess.Environments, { Role: TenantRoles.Admin, AppRole: TenantRoles.EnvironmentAdmin }],
        [TenantApiAccess.Admin, { Role: TenantRoles.Admin }],
    ])

    private readonly health: HiveHealthProducer

    public constructor(
        private readonly service: IEnvironmentService,
        private readonly directory: ITenantDirectory,
        private readonly rolloutClient: IRolloutClient,
        orchestrators: HiveOrchestratorFactory,
        placement: EnvironmentPlacement,
        /** The tenant's email domains (GET/PUT /tenant-api/settings/email-domains); undefined leaves those paths unrouted (404). */
        private readonly emailDomains?: ITenantEmailDomains,
        /** The graph routes (.../environments/NAME/graphs[/GRAPH]); undefined leaves those paths unrouted (404). */
        private readonly graphs?: TenantGraphAccess)
    {
        this.health = new HiveHealthProducer(service, orchestrators, placement)
    }

    /** The signed-in admin's profile, the one the console's `/tenant-api/profile` and the desktop's `/desktop/profile` both report. */
    public Profile(session: TenantSession): TenantProfileDto
    {
        const tenant = this.directory.GetTenant(session.tenantId)
        const hive = this.directory.ListHives(session.tenantId)[0]
        return TenantProfileMapper.ToDto(session, tenant, hive, this.directory.GetOrganisation?.(session.tenantId), TenantAdminCapabilities.For(session))
    }

    /** The roles a route of `access` names (the one table the route policy test checks). */
    public static RolesOf(access: TenantApiAccess): { Role?: string; AppRole?: string }
    {
        return TenantApiEndpoint.Roles.get(access) ?? {}
    }

    /** Declares every tenant API route on the host's table (see the class comment for the roles). */
    public Register(table: RouteTable): void
    {
        const M = TenantApiEndpoint
        const R = TenantApiAccess
        const add = (method: HttpMethod, pattern: string, access: TenantApiAccess, run: (ctx: RequestContext, session: TenantSession) => Promise<void>, bodyLimit?: number): void =>
        {
            table.Add({
                Method: method,
                Pattern: pattern,
                Auth: RouteAuth.Session,
                ...M.RolesOf(access),
                ...(bodyLimit === undefined ? {} : { BodyLimit: bodyLimit }),
                Handler: ctx => run(ctx, M.SessionOf(ctx)),
            })
        }
        add(HttpMethod.Get, M.ProfilePath, R.Read, async (ctx, s) => this.WriteJson(ctx.Response, M.StatusOk, this.Profile(s)))
        add(HttpMethod.Get, M.HivesPath, R.Read, async (ctx, s) => this.WriteJson(ctx.Response, M.StatusOk, this.directory.ListHives(s.tenantId).map(h => HiveDtoMapper.ToDto(h))))
        add(HttpMethod.Get, M.EnvironmentsPath, R.Read, (ctx, s) => this.RouteEnvList(ctx.Response, s))
        add(HttpMethod.Get, M.ManifestsPath, R.Read, (ctx, s) => this.RouteManifests(ctx.Response, s))
        add(HttpMethod.Get, M.HiveRolloutPath, R.Read, (ctx, s) => this.RouteHiveRollout(ctx.Response, ctx.Param(M.IdParam), s))
        add(HttpMethod.Get, M.HiveHealthPath, R.Read, (ctx, s) => this.RouteHiveHealth(ctx.Response, ctx.Param(M.IdParam), s))
        add(HttpMethod.Get, M.HiveLedgerPath, R.Read, (ctx, s) => this.RouteHiveLedger(ctx.Response, ctx.Param(M.IdParam), s))
        add(HttpMethod.Post, M.HiveTargetPath, R.Environments, (ctx, s) => this.RouteHiveTarget(ctx.Request, ctx.Response, ctx.Param(M.IdParam), s))
        add(HttpMethod.Post, M.EnvironmentsPath, R.Environments, (ctx, s) => this.RouteEnvCreate(ctx.Request, ctx.Response, s))
        for (const action of Object.values(TenantEnvAction))
        {
            add(HttpMethod.Post, M.EnvActionPathPrefix + action, R.Environments, (ctx, s) => this.RouteEnvAction(ctx.Response, ctx.Param(M.NameParam), action, s))
        }
        add(HttpMethod.Delete, M.EnvPath, R.Environments, (ctx, s) => this.RouteEnvDelete(ctx.Response, ctx.Param(M.NameParam), s))
        add(HttpMethod.Post, M.MakerTokenPath, R.Environments, (ctx, s) => this.RouteEnvCredential(ctx.Response, ctx.Param(M.NameParam), true, s))
        add(HttpMethod.Post, M.AppReaderPath, R.Environments, (ctx, s) => this.RouteEnvCredential(ctx.Response, ctx.Param(M.NameParam), false, s))
        for (const leaf of Object.values(AdminReadLeaf))
        {
            add(HttpMethod.Get, M.AdminPathPrefix + leaf, R.Read, (ctx, s) => this.RouteAdmin(ctx.Response, ctx.Param(M.NameParam), s, name => this.AdminRead(ctx.Response, name, leaf)))
        }
        add(HttpMethod.Get, M.TeamMembersPath, R.Read, (ctx, s) => this.RouteAdmin(ctx.Response, ctx.Param(M.NameParam), s,
            async name => this.WriteJson(ctx.Response, M.StatusOk, await this.service.AdminListTeamMembers(name, ctx.Param(M.TeamParam)))))
        add(HttpMethod.Post, M.AccountsPath, R.Admin, (ctx, s) => this.RouteAdmin(ctx.Response, ctx.Param(M.NameParam), s, name => this.AdminCreateAccount(ctx.Request, ctx.Response, name)))
        add(HttpMethod.Delete, M.AccountPath, R.Admin, (ctx, s) => this.RouteAdmin(ctx.Response, ctx.Param(M.NameParam), s, async name =>
        {
            await this.service.AdminDisableAccount(name, ctx.Param(M.PrincipalParam))
            this.WriteJson(ctx.Response, M.StatusOk, { [M.OkKey]: true })
        }))
        add(HttpMethod.Post, M.GrantsPath, R.Admin, (ctx, s) => this.RouteAdmin(ctx.Response, ctx.Param(M.NameParam), s, name => this.AdminGrant(ctx.Request, ctx.Response, name, true)))
        add(HttpMethod.Delete, M.GrantsPath, R.Admin, (ctx, s) => this.RouteAdmin(ctx.Response, ctx.Param(M.NameParam), s, name => this.AdminGrant(ctx.Request, ctx.Response, name, false)))
        add(HttpMethod.Post, M.TokensPath, R.Admin, (ctx, s) => this.RouteAdmin(ctx.Response, ctx.Param(M.NameParam), s, name => this.AdminIssueToken(ctx.Request, ctx.Response, name)))
        add(HttpMethod.Delete, M.TokensPath, R.Admin, (ctx, s) => this.RouteAdmin(ctx.Response, ctx.Param(M.NameParam), s, name => this.AdminRevokeToken(ctx.Request, ctx.Response, name)))
        add(HttpMethod.Put, M.SecurityModelPath, R.Admin, (ctx, s) => this.RouteAdmin(ctx.Response, ctx.Param(M.NameParam), s, name => this.AdminSetSecurityModel(ctx.Request, ctx.Response, name)))
        add(HttpMethod.Put, M.ConfigPath, R.Admin, (ctx, s) => this.RouteAdmin(ctx.Response, ctx.Param(M.NameParam), s, name => this.AdminSetConfig(ctx.Request, ctx.Response, name)))
        const graphs = this.graphs
        if (graphs !== undefined)
        {
            add(HttpMethod.Get, M.GraphsPath, R.Read, (ctx, s) => this.RouteGraphs(ctx, s, graphs, undefined))
            add(HttpMethod.Post, M.GraphsPath, R.Environments, (ctx, s) => this.RouteGraphs(ctx, s, graphs, undefined))
            add(HttpMethod.Delete, M.GraphPath, R.Environments, (ctx, s) => this.RouteGraphs(ctx, s, graphs, ctx.Param(M.GraphParam)))
        }
        const domains = this.emailDomains
        if (domains !== undefined)
        {
            add(HttpMethod.Get, M.EmailDomainsPath, R.Read, async (ctx, s) => this.WriteEmailDomains(ctx.Response, s, await domains.For(s.tenantId)))
            add(HttpMethod.Put, M.EmailDomainsPath, R.Admin, (ctx, s) => this.RouteSetEmailDomains(ctx.Request, ctx.Response, s, domains), TenantEmailDomainsLimits.MaxBodyBytes)
            add(HttpMethod.Post, M.EmailDomainsVerifyPath, R.Admin, (ctx, s) => this.RouteEmailDomainsVerify(ctx.Request, ctx.Response, s, domains), TenantEmailDomainsLimits.MaxBodyBytes)
        }
    }

    /** The route's session as the handlers see it (the host has authenticated it; a session without a tenant is not one of ours). */
    private static SessionOf(ctx: RequestContext): TenantSession
    {
        const view = TenantSessionClaims.ViewOf(ctx.RequireSession())
        if (view === undefined)
        {
            throw new HttpProblem(TenantApiEndpoint.StatusUnauthorized, TenantApiEndpoint.UnauthenticatedMessage)
        }
        return view
    }

    private async RouteEnvList(res: ServerResponse, session: TenantSession): Promise<void>
    {
        const dtos = (await this.service.ListReconciled())
            .filter(r => r.tenantId === session.tenantId)
            .map(r => EnvironmentDtoMapper.ToDto(r))
        this.WriteJson(res, TenantApiEndpoint.StatusOk, dtos)
    }

    private async RouteManifests(res: ServerResponse, session: TenantSession): Promise<void>
    {
        try
        {
            this.WriteJson(res, TenantApiEndpoint.StatusOk, [...await this.rolloutClient.ManifestsFor(session.tenantId)])
        }
        catch (err)
        {
            this.WriteRolloutError(res, err)
        }
    }

    /** The tenant's own hive, or undefined (answered 404, not 403, when unknown or another tenant's: existence is never revealed). */
    private OwnedHive(id: string, session: TenantSession): ReturnType<ITenantDirectory['GetHive']>
    {
        const hive = this.directory.GetHive(id)
        return hive === undefined || hive.tenantId !== session.tenantId ? undefined : hive
    }

    private async RouteHiveRollout(res: ServerResponse, id: string, session: TenantSession): Promise<void>
    {
        const hive = this.OwnedHive(id, session)
        if (hive === undefined)
        {
            this.WriteNotFound(res)
            return
        }
        try
        {
            this.WriteJson(res, TenantApiEndpoint.StatusOk, await this.rolloutClient.StatusFor(hive.id))
        }
        catch (err)
        {
            this.WriteRolloutError(res, err)
        }
    }

    private async RouteHiveLedger(res: ServerResponse, id: string, session: TenantSession): Promise<void>
    {
        const hive = this.OwnedHive(id, session)
        if (hive === undefined)
        {
            this.WriteNotFound(res)
            return
        }
        this.WriteJson(res, TenantApiEndpoint.StatusOk, [...await this.rolloutClient.LedgerFor(hive.id, TenantApiEndpoint.LedgerLimit)])
    }

    private async RouteHiveHealth(res: ServerResponse, id: string, session: TenantSession): Promise<void>
    {
        const hive = this.OwnedHive(id, session)
        if (hive === undefined)
        {
            this.WriteNotFound(res)
            return
        }
        this.WriteJson(res, TenantApiEndpoint.StatusOk, await this.health.Produce(hive))
    }

    /**
     * Rolls the tenant's own hive to a published version. The ownership guard runs before anything else, so an unknown
     * or cross-tenant hive 404s without the body being read or `SelectTarget` ever being called. A not-gated version →
     * 409 and an unknown version → 404, both with a fixed generic body (no version id, no engine message); any other
     * error bubbles to the host's problem mapper.
     */
    private async RouteHiveTarget(req: IncomingMessage, res: ServerResponse, id: string, session: TenantSession): Promise<void>
    {
        const hive = this.OwnedHive(id, session)
        if (hive === undefined)
        {
            this.WriteNotFound(res)
            return
        }
        const version = await this.ReadVersion(req, res)
        if (version === undefined)
        {
            return
        }
        try
        {
            await this.rolloutClient.AdoptTarget(hive.id, version)
        }
        catch (err)
        {
            this.WriteTargetError(res, err)
            return
        }
        res.writeHead(TenantApiEndpoint.StatusNoContent)
        res.end()
    }

    /** Maps the rollout engine's selection errors to fixed generic bodies; rethrows anything else so the host's problem mapper answers. */
    private WriteTargetError(res: ServerResponse, err: unknown): void
    {
        if (err instanceof RolloutUnavailableError)
        {
            this.WriteRolloutError(res, err)
            return
        }
        // A registry release (hives cannot run those yet) is refused the same way: the tenant never learns which rule failed.
        if (err instanceof ManifestNotGatedError || err instanceof RolloutAdoptionRefusedError || err instanceof ManifestWithdrawnError || err instanceof TenantOnHoldError || err instanceof ChannelNotSubscribedError || err instanceof VersionBelowFloorError
            || err instanceof ReleaseNotRunnableYetError)
        {
            this.WriteJson(res, TenantApiEndpoint.StatusConflict, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.TargetUnavailableMessage })
            return
        }
        if (err instanceof UnknownManifestError || err instanceof UnknownHiveError)
        {
            this.WriteNotFound(res)
            return
        }
        throw err
    }

    /** A rollout client with no operator link answers 503 with its clear message; anything else rethrows to the host's problem mapper. */
    private WriteRolloutError(res: ServerResponse, err: unknown): void
    {
        if (err instanceof RolloutUnavailableError)
        {
            this.WriteJson(res, TenantApiEndpoint.StatusUnavailable, { [TenantApiEndpoint.ErrorKey]: err.message })
            return
        }
        throw err
    }

    /** Starts/stops/restarts the tenant's own environment; 404 (not 403) when the env is unknown or owned by another tenant, so the service action is never reached. */
    private async RouteEnvAction(res: ServerResponse, name: string, action: TenantEnvAction, session: TenantSession): Promise<void>
    {
        const rec = this.OwnedEnv(name, session)
        if (rec === undefined)
        {
            this.WriteNotFound(res)
            return
        }
        const updated = await this.Perform(action, rec.name)
        this.WriteJson(res, TenantApiEndpoint.StatusOk, EnvironmentDtoMapper.ToDto(updated))
    }

    /** Deletes the tenant's own environment (204); 404 (not 403) when unknown or owned by another tenant, so existence is never revealed and the service Delete is never reached. */
    private async RouteEnvDelete(res: ServerResponse, name: string, session: TenantSession): Promise<void>
    {
        const rec = this.OwnedEnv(name, session)
        if (rec === undefined)
        {
            this.WriteNotFound(res)
            return
        }
        await this.service.Delete(rec.name)
        res.writeHead(TenantApiEndpoint.StatusNoContent)
        res.end()
    }

    /**
     * Creates an environment in the caller's own hive. The hive is derived ONLY from `session.tenantId` via the
     * directory (one hive per tenant) - the body is never consulted for a hive or tenant, so it cannot steer creation
     * cross-tenant. The body is validated before anything is created; failures map to fixed generic bodies.
     */
    private async RouteEnvCreate(req: IncomingMessage, res: ServerResponse, session: TenantSession): Promise<void>
    {
        const body = await this.ReadObject(req, res)
        if (body === undefined)
        {
            return
        }
        const name = body[TenantApiEndpoint.NameKey]
        const template = body[TenantApiEndpoint.TemplateKey]
        const type = body[TenantApiEndpoint.TypeKey]
        if (typeof name !== 'string' || name.length === 0
            || !Object.values(Template).includes(template as Template)
            || !Object.values(EnvType).includes(type as EnvType))
        {
            this.WriteJson(res, TenantApiEndpoint.StatusBadRequest, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.CreateFieldsMessage })
            return
        }
        const hive = this.directory.ListHives(session.tenantId)[0]
        if (hive === undefined)
        {
            this.WriteJson(res, TenantApiEndpoint.StatusConflict, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.NoHiveMessage })
            return
        }
        try
        {
            const record = await this.service.Create(name, template as Template, type as EnvType, undefined, hive.id, session.principalId)
            this.WriteJson(res, TenantApiEndpoint.StatusCreated, EnvironmentDtoMapper.ToDto(record))
        }
        catch (err)
        {
            this.WriteCreateError(res, err)
        }
    }

    /**
     * Maps a create failure to a fixed status and body; the caught error's own text is never echoed. A rolled-back
     * create adds only its showable reason (a cause known to be safe, e.g. an image the hive refused) and whether a
     * Failed record was kept. Every unexpected failure is logged (secret-redacted) so the operator can see the cause.
     */
    private WriteCreateError(res: ServerResponse, err: unknown): void
    {
        const C = TenantApiEndpoint
        let status = C.StatusInternal
        let message = C.CreateFailedMessage
        if (err instanceof EnvironmentExistsError)
        {
            status = C.StatusConflict
            message = C.CreateExistsMessage
        }
        else if (err instanceof TenantSignInInHiveError)
        {
            status = C.StatusConflict
            message = err.message
        }
        else if (err instanceof UnsupportedBackendError)
        {
            status = C.StatusBadRequest
            message = C.CreateUnsupportedMessage
        }
        else if (err instanceof CreateFailedError)
        {
            console.error(C.CreateFailedLogPrefix, err.message, err.Detail ?? C.NoDetail)
            const sentences = [C.CreateFailedMessage + C.SentenceEnd]
            if (err.ShowableReason !== undefined)
            {
                sentences.push(err.ShowableReason)
            }
            if (err.Recorded)
            {
                sentences.push(C.CreateFailedRecordedMessage)
            }
            message = sentences.join(C.SentenceSeparator)
        }
        else
        {
            console.error(C.CreateFailedLogPrefix, err)
        }
        this.WriteJson(res, status, { [TenantApiEndpoint.ErrorKey]: message })
    }

    /** Dispatches the validated action to the matching service method. */
    private async Perform(action: TenantEnvAction, name: string): Promise<EnvironmentRecord>
    {
        switch (action)
        {
            case TenantEnvAction.Start:
                return await this.service.Start(name)
            case TenantEnvAction.Stop:
                return await this.service.Stop(name)
            default:
                return await this.service.Restart(name)
        }
    }

    /** Resolves the env record only when it belongs to the session's tenant; undefined (to be answered 404, never 403) for unknown or cross-tenant names. */
    private OwnedEnv(name: string, session: TenantSession): EnvironmentRecord | undefined
    {
        const rec = this.service.List().find(r => r.name === name)
        return rec === undefined || rec.tenantId !== session.tenantId ? undefined : rec
    }

    /**
     * Runs one per-environment identity-admin route: the ownership guard runs first, so a foreign env 404s before any body
     * is read or service call made; an engine failure is answered with a fixed generic body (WriteIdentityError).
     */
    private async RouteAdmin(res: ServerResponse, name: string, session: TenantSession, run: (envName: string) => Promise<void>): Promise<void>
    {
        const rec = this.OwnedEnv(name, session)
        if (rec === undefined)
        {
            this.WriteNotFound(res)
            return
        }
        try
        {
            await run(rec.name)
        }
        catch (err)
        {
            this.WriteIdentityError(res, err)
        }
    }

    /**
     * PUT /tenant-api/settings/email-domains for the session's own tenant (never an id from the request): the host admits the
     * tenant admin only; a `{ domains }` body within the 16 KiB cap (400), and the store's refusals as 400 / 409 sentences.
     */
    private async RouteSetEmailDomains(req: IncomingMessage, res: ServerResponse, session: TenantSession, store: ITenantEmailDomains): Promise<void>
    {
        const M = TenantApiEndpoint
        const raw = await M.ReadBody(req, TenantEmailDomainsLimits.MaxBodyBytes)
        let body: unknown
        try
        {
            body = JSON.parse(raw)
        }
        catch
        {
            this.WriteJson(res, M.StatusBadRequest, { [M.ErrorKey]: M.BadJsonMessage })
            return
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body) || !(M.DomainsKey in body))
        {
            this.WriteJson(res, M.StatusBadRequest, { [M.ErrorKey]: TenantEmailDomainsLimits.DomainsRequiredMessage })
            return
        }
        let view: TenantEmailDomainsView
        try
        {
            view = await store.Set(session.tenantId, (body as Record<string, unknown>)[M.DomainsKey])
        }
        catch (err)
        {
            if (err instanceof InvalidEmailDomainError)
            {
                this.WriteJson(res, M.StatusBadRequest, { [M.ErrorKey]: err.message })
                return
            }
            if (err instanceof EmailDomainsNotEditableError)
            {
                this.WriteJson(res, M.StatusConflict, { [M.ErrorKey]: err.message })
                return
            }
            throw err
        }
        this.WriteEmailDomains(res, session, view)
    }

    /**
     * POST /tenant-api/settings/email-domains/verify for the session's own tenant (never an id from the request): the tenant
     * admin names one claimed domain in a `{ domain }` body within the 16 KiB cap, and the store checks its DNS TXT record
     * now. Answers the updated view (200), or the store's refusal as 400 / 409 / 429 / 503 with its sentence.
     */
    private async RouteEmailDomainsVerify(req: IncomingMessage, res: ServerResponse, session: TenantSession, store: ITenantEmailDomains): Promise<void>
    {
        const M = TenantApiEndpoint
        const raw = await M.ReadBody(req, TenantEmailDomainsLimits.MaxBodyBytes)
        let body: unknown
        try
        {
            body = JSON.parse(raw)
        }
        catch
        {
            this.WriteJson(res, M.StatusBadRequest, { [M.ErrorKey]: M.BadJsonMessage })
            return
        }
        const domain = body === null || typeof body !== 'object' || Array.isArray(body) ? undefined : (body as Record<string, unknown>)[M.DomainKey]
        if (typeof domain !== 'string')
        {
            this.WriteJson(res, M.StatusBadRequest, { [M.ErrorKey]: TenantEmailDomainsLimits.DomainRequiredMessage })
            return
        }
        let view: TenantEmailDomainsView
        try
        {
            view = await store.Verify(session.tenantId, domain)
        }
        catch (err)
        {
            const status = M.VerifyErrorStatus(err)
            if (status === undefined)
            {
                throw err
            }
            this.WriteJson(res, status, { [M.ErrorKey]: (err as Error).message })
            return
        }
        this.WriteEmailDomains(res, session, view)
    }

    /** The HTTP status a store's verify refusal maps to, or undefined when the error is not one of its refusals. */
    private static VerifyErrorStatus(err: unknown): number | undefined
    {
        if (err instanceof InvalidEmailDomainError)
        {
            return TenantApiEndpoint.StatusBadRequest
        }
        if (err instanceof DomainNotClaimedError || err instanceof EmailDomainsNotEditableError)
        {
            return TenantApiEndpoint.StatusConflict
        }
        if (err instanceof DomainVerifyThrottledError)
        {
            return TenantApiEndpoint.StatusTooManyRequests
        }
        if (err instanceof DomainVerificationUnavailableError)
        {
            return TenantApiEndpoint.StatusUnavailable
        }
        return undefined
    }

    /**
     * The view as the caller may use it: editable only when the store allows it and the caller holds the settings capability (the tenant admin);
     * `pending` lists the domains not in effect yet (neither approved nor verified and uncontested, or revoked); `verifications`
     * carries each claimed domain's TXT record and state.
     */
    private WriteEmailDomains(res: ServerResponse, session: TenantSession, view: TenantEmailDomainsView): void
    {
        const caps = TenantAdminCapabilities.For(session).capabilities
        this.WriteJson(res, TenantApiEndpoint.StatusOk, {
            domains: view.domains, editable: view.editable && caps[TenantApiEndpoint.SettingsCapability], inHive: view.inHive, pending: view.pending,
            verifications: view.verifications,
        })
    }

    /** Serves the identity-admin reads (snapshot, config, tokens, security model, security catalog, security changes). */
    private async AdminRead(res: ServerResponse, name: string, leaf: AdminReadLeaf): Promise<void>
    {
        if (leaf === AdminReadLeaf.Snapshot)
        {
            this.WriteJson(res, TenantApiEndpoint.StatusOk, await this.service.AdminSnapshot(name))
            return
        }
        if (leaf === AdminReadLeaf.Config)
        {
            this.WriteJson(res, TenantApiEndpoint.StatusOk, await this.service.AdminGetConfig(name))
            return
        }
        if (leaf === AdminReadLeaf.Tokens)
        {
            this.WriteJson(res, TenantApiEndpoint.StatusOk, await this.service.AdminListTokens(name))
            return
        }
        if (leaf === AdminReadLeaf.SecurityModel)
        {
            // JSON null (not undefined) so the body is always valid JSON when no model is stored.
            this.WriteJson(res, TenantApiEndpoint.StatusOk, await this.service.AdminGetSecurityModel(name) ?? null)
            return
        }
        if (leaf === AdminReadLeaf.SecurityCatalog)
        {
            this.WriteJson(res, TenantApiEndpoint.StatusOk, await this.service.AdminGetSecurityCatalog(name))
            return
        }
        this.WriteJson(res, TenantApiEndpoint.StatusOk, await this.service.AdminListSecurityChanges(name))
    }

    private async AdminCreateAccount(req: IncomingMessage, res: ServerResponse, name: string): Promise<void>
    {
        const body = await this.ReadObject(req, res)
        if (body === undefined)
        {
            return
        }
        if (!TenantApiEndpoint.NonEmpty(body.email) || !TenantApiEndpoint.NonEmpty(body.principalId) || !TenantApiEndpoint.NonEmpty(body.password))
        {
            this.WriteJson(res, TenantApiEndpoint.StatusBadRequest, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.AccountFieldsMessage })
            return
        }
        const account = { email: body.email, principalId: body.principalId, password: body.password } as unknown as CreateAccountParams
        await this.service.AdminCreateAccount(name, account)
        this.WriteJson(res, TenantApiEndpoint.StatusCreated, { [TenantApiEndpoint.OkKey]: true })
    }

    /** Issues a service token; the secret is returned only here, never cached. */
    private async AdminIssueToken(req: IncomingMessage, res: ServerResponse, name: string): Promise<void>
    {
        const body = await this.ReadObject(req, res)
        if (body === undefined)
        {
            return
        }
        const expires = body.expiresInSeconds
        const scopes = body.scopes
        const scopesOk = Array.isArray(scopes) && scopes.length > 0 && scopes.every(x => TenantApiEndpoint.NonEmpty(x) && (x as string).trim().length > 0)
        const expiresOk = expires === undefined || expires === null || (typeof expires === 'number' && Number.isInteger(expires) && expires > 0)
        if (!TenantApiEndpoint.NonEmpty(body.principalId) || !scopesOk || !expiresOk)
        {
            this.WriteJson(res, TenantApiEndpoint.StatusBadRequest, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.TokenIssueFieldsMessage })
            return
        }
        const params = { principalId: body.principalId, scopes: (scopes as string[]).map(x => x.trim()), expiresInSeconds: expires ?? null } as unknown as IssueTokenParams
        const issued = await this.service.AdminIssueToken(name, params)
        this.WriteJson(res, TenantApiEndpoint.StatusCreated, issued, { [TenantApiEndpoint.CacheControlHeader]: TenantApiEndpoint.NoStore })
    }

    /** Revokes a service token; the tokenRef travels in the body because it contains slashes. */
    private async AdminRevokeToken(req: IncomingMessage, res: ServerResponse, name: string): Promise<void>
    {
        const body = await this.ReadObject(req, res)
        if (body === undefined)
        {
            return
        }
        if (!TenantApiEndpoint.NonEmpty(body.tokenRef))
        {
            this.WriteJson(res, TenantApiEndpoint.StatusBadRequest, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.TokenRefMessage })
            return
        }
        await this.service.AdminRevokeToken(name, body.tokenRef as string)
        this.WriteJson(res, TenantApiEndpoint.StatusOk, { [TenantApiEndpoint.OkKey]: true })
    }

    /** POST grants a role, DELETE revokes it; both read the same `{ subject, role, resourceKind?, resourcePath? }` body. */
    private async AdminGrant(req: IncomingMessage, res: ServerResponse, name: string, grant: boolean): Promise<void>
    {
        const body = await this.ReadObject(req, res)
        if (body === undefined)
        {
            return
        }
        if (typeof body.subject !== 'string' || typeof body.role !== 'string')
        {
            this.WriteJson(res, TenantApiEndpoint.StatusBadRequest, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.GrantFieldsMessage })
            return
        }
        const mutation = {
            subject: body.subject,
            role: body.role,
            resourceKind: body.resourceKind,
            resourcePath: body.resourcePath
        } as unknown as GrantMutationDto
        if (grant)
        {
            await this.service.AdminGrantRole(name, mutation)
        }
        else
        {
            await this.service.AdminRevokeRole(name, mutation)
        }
        this.WriteJson(res, TenantApiEndpoint.StatusOk, { [TenantApiEndpoint.OkKey]: true })
    }

    private async AdminSetSecurityModel(req: IncomingMessage, res: ServerResponse, name: string): Promise<void>
    {
        const body = await this.ReadObject(req, res)
        if (body === undefined)
        {
            return
        }
        if (typeof body.securityModel !== 'object' || body.securityModel === null)
        {
            this.WriteJson(res, TenantApiEndpoint.StatusBadRequest, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.SecurityModelFieldMessage })
            return
        }
        await this.service.AdminSetSecurityModel(name, body.securityModel as SecurityModelDto)
        this.WriteJson(res, TenantApiEndpoint.StatusOk, { [TenantApiEndpoint.OkKey]: true })
    }

    private async AdminSetConfig(req: IncomingMessage, res: ServerResponse, name: string): Promise<void>
    {
        const body = await this.ReadObject(req, res)
        if (body === undefined)
        {
            return
        }
        if (typeof body.packId !== 'string' || typeof body.delegationDepth !== 'string')
        {
            this.WriteJson(res, TenantApiEndpoint.StatusBadRequest, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.ConfigFieldsMessage })
            return
        }
        const config = {
            packId: body.packId,
            delegationDepth: body.delegationDepth,
            providerSettings: body.providerSettings,
            groupRoleMap: body.groupRoleMap,
            claimsMapping: body.claimsMapping,
            securityModel: body.securityModel
        } as unknown as IdentityConfigDto
        await this.service.AdminSetConfig(name, config)
        this.WriteJson(res, TenantApiEndpoint.StatusOk, { [TenantApiEndpoint.OkKey]: true })
    }

    /**
     * GET lists, POST creates, DELETE .../GRAPH deletes the graphs of the tenant's own Development environment (the host has
     * already admitted the route's roles). In this order: ownership (404, never 403, not audited), a Development environment
     * (400), reach (503), the POST body (400), then the call. Every POST or DELETE past the ownership check is audited in the
     * graph audit once with its final status, after the answer is written.
     */
    private async RouteGraphs(ctx: RequestContext, session: TenantSession, graphs: TenantGraphAccess, rawGraph: string | undefined): Promise<void>
    {
        const M = TenantApiEndpoint
        const req = ctx.Request
        const res = ctx.Response
        const method = req.method ?? M.MethodGet
        const rec = this.OwnedEnv(ctx.Param(M.NameParam), session)
        if (rec === undefined)
        {
            this.WriteNotFound(res)
            return
        }
        const list = method === M.MethodGet
        const graph = rawGraph ?? M.NoDetail
        // A failure escaping AnswerGraph (the body stream errored) is answered 500 by the host's problem mapper: record that.
        let outcome: GraphOutcome = { status: M.StatusInternal, graph }
        try
        {
            outcome = await this.AnswerGraph(req, res, method, rec, graph, graphs)
        }
        finally
        {
            if (!list)
            {
                await graphs.Record(session, method, ctx.Path, outcome.status, rec.name, outcome.graph)
            }
        }
    }

    /** Runs a shaped graph request; writes the answer and returns its status and the graph name to note. */
    private async AnswerGraph(req: IncomingMessage, res: ServerResponse, method: string, rec: EnvironmentRecord, graph: string, graphs: TenantGraphAccess): Promise<GraphOutcome>
    {
        const M = TenantApiEndpoint
        if (rec.type !== EnvType.Development)
        {
            return this.WriteGraphError(res, M.StatusBadRequest, TenantGraphAccess.NotDevelopmentMessage, graph)
        }
        const service = graphs.Service
        if (service === undefined)
        {
            return this.WriteGraphError(res, M.StatusUnavailable, TenantGraphAccess.UnreachableMessage, graph)
        }
        let name = graph
        let description = M.NoDetail
        if (method === M.MethodPost)
        {
            const body = await this.ReadObject(req, res)
            if (body === undefined)
            {
                return { status: M.StatusBadRequest, graph }
            }
            const rawName = body[M.NameKey]
            const rawDescription = body[M.DescriptionKey] === undefined ? M.NoDetail : body[M.DescriptionKey]
            name = M.NonEmpty(rawName) ? rawName as string : M.NoDetail
            if (name.length === 0 || typeof rawDescription !== 'string')
            {
                return this.WriteGraphError(res, M.StatusBadRequest, TenantGraphAccess.FieldsMessage, name)
            }
            description = rawDescription
        }
        try
        {
            if (method === M.MethodGet)
            {
                this.WriteJson(res, M.StatusOk, [...await service.List(rec.name)])
                return { status: M.StatusOk, graph: name }
            }
            if (method === M.MethodPost)
            {
                this.WriteJson(res, M.StatusCreated, await service.Create(rec.name, name, description))
                return { status: M.StatusCreated, graph: name }
            }
            await service.Delete(rec.name, name)
            res.writeHead(M.StatusNoContent)
            res.end()
            return { status: M.StatusNoContent, graph: name }
        }
        catch (err)
        {
            const status = TenantGraphAccess.StatusOf(err)
            if (status === M.StatusInternal)
            {
                // Only the error's name: messages from lower layers are not vetted for secret material.
                console.error(M.GraphFailedLogPrefix, err instanceof Error ? err.name : typeof err)
            }
            return this.WriteGraphError(res, status, TenantGraphAccess.MessageOf(err), name)
        }
    }

    private WriteGraphError(res: ServerResponse, status: number, message: string, graph: string): GraphOutcome
    {
        this.WriteJson(res, status, { [TenantApiEndpoint.ErrorKey]: message })
        return { status, graph }
    }

    /** POST maker-token (201 + the once-only token DTO) and POST app-reader-grant (200 { ok }, no secret) on the tenant's own environment (404 for a foreign one). */
    private async RouteEnvCredential(res: ServerResponse, name: string, makerToken: boolean, session: TenantSession): Promise<void>
    {
        const rec = this.OwnedEnv(name, session)
        if (rec === undefined)
        {
            this.WriteNotFound(res)
            return
        }
        try
        {
            if (makerToken)
            {
                const issued = await this.service.AdminIssueMakerToken(rec.name)
                const dto: MakerTokenDto = { token: issued.token, principalId: issued.principalId, expiresAt: issued.expiresAt }
                this.WriteJson(res, TenantApiEndpoint.StatusCreated, dto)
            }
            else
            {
                await this.service.AdminGrantAppReader(rec.name)
                this.WriteJson(res, TenantApiEndpoint.StatusOk, { [TenantApiEndpoint.OkKey]: true })
            }
        }
        catch (err)
        {
            this.WriteIdentityError(res, err)
        }
    }

    /** Maps an identity-admin failure to a fixed status and a fixed generic body; the caught error (and its text) is never echoed or logged. */
    private WriteIdentityError(res: ServerResponse, err: unknown): void
    {
        let status = TenantApiEndpoint.StatusInternal
        let message = TenantApiEndpoint.IdentityFailedMessage
        if (err instanceof EnvironmentNotDevelopmentError || err instanceof EnvironmentNotRuntimeError)
        {
            status = TenantApiEndpoint.StatusBadRequest
            message = TenantApiEndpoint.WrongEnvKindMessage
        }
        else if (err instanceof EnvironmentNotFoundError)
        {
            status = TenantApiEndpoint.StatusNotFound
            message = TenantApiEndpoint.NotFoundMessage
        }
        else if (err instanceof AdminProxyError)
        {
            switch (err.Kind)
            {
                case AdminProxyErrorKind.Connect:
                    status = TenantApiEndpoint.StatusUnavailable
                    message = TenantApiEndpoint.IdentityUnavailableMessage
                    break
                case AdminProxyErrorKind.Rbac:
                    status = TenantApiEndpoint.StatusConflict
                    message = TenantApiEndpoint.IdentityConflictMessage
                    break
                case AdminProxyErrorKind.NotFound:
                    status = TenantApiEndpoint.StatusNotFound
                    message = TenantApiEndpoint.NotFoundMessage
                    break
                case AdminProxyErrorKind.Invalid:
                    status = TenantApiEndpoint.StatusBadRequest
                    message = TenantApiEndpoint.IdentityInvalidMessage
                    break
                default:
                    break
            }
        }
        this.WriteJson(res, status, { [TenantApiEndpoint.ErrorKey]: message })
    }

    private static NonEmpty(v: unknown): boolean
    {
        return typeof v === 'string' && v.length > 0
    }

    /** Reads a capped JSON-object body; writes the 400 and returns undefined when it is malformed, oversized, or not an object. */
    private async ReadObject(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined>
    {
        const raw = await TenantApiEndpoint.ReadBody(req)
        let body: unknown
        try
        {
            body = JSON.parse(raw)
        }
        catch
        {
            this.WriteJson(res, TenantApiEndpoint.StatusBadRequest, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.BadJsonMessage })
            return undefined
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body))
        {
            this.WriteJson(res, TenantApiEndpoint.StatusBadRequest, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.BodyObjectMessage })
            return undefined
        }
        return body as Record<string, unknown>
    }

    /** Reads and validates the `{ version }` body; writes the 400 and returns undefined when it is missing or malformed. */
    private async ReadVersion(req: IncomingMessage, res: ServerResponse): Promise<string | undefined>
    {
        const raw = await TenantApiEndpoint.ReadBody(req)
        let body: unknown
        try
        {
            body = JSON.parse(raw)
        }
        catch
        {
            this.WriteJson(res, TenantApiEndpoint.StatusBadRequest, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.BadJsonMessage })
            return undefined
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body))
        {
            this.WriteJson(res, TenantApiEndpoint.StatusBadRequest, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.BodyObjectMessage })
            return undefined
        }
        const version = (body as Record<string, unknown>)[TenantApiEndpoint.VersionKey]
        if (typeof version !== 'string' || version.length === 0)
        {
            this.WriteJson(res, TenantApiEndpoint.StatusBadRequest, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.VersionRequiredMessage })
            return undefined
        }
        return version
    }

    /** Collects the request body (capped at `maxBytes`); an over-large body resolves empty so it fails JSON parsing and is answered as a 400. */
    private static ReadBody(req: IncomingMessage, maxBytes: number = TenantApiEndpoint.MaxBodyBytes): Promise<string>
    {
        return new Promise((resolveBody, reject) =>
        {
            const chunks: Buffer[] = []
            let size = 0
            let tooLarge = false
            req.on(TenantApiEndpoint.DataEvent, (c: Buffer) =>
            {
                size += c.length
                if (size > maxBytes)
                {
                    tooLarge = true
                    return
                }
                chunks.push(c)
            })
            req.on(TenantApiEndpoint.EndEvent, () =>
            {
                resolveBody(tooLarge ? '' : Buffer.concat(chunks).toString(TenantApiEndpoint.Utf8))
            })
            req.on(TenantApiEndpoint.ErrorEvent, reject)
        })
    }

    private WriteNotFound(res: ServerResponse): void
    {
        this.WriteJson(res, TenantApiEndpoint.StatusNotFound, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.NotFoundMessage })
    }

    private WriteJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void
    {
        res.writeHead(status, { [TenantApiEndpoint.ContentTypeHeader]: TenantApiEndpoint.JsonType, ...extraHeaders })
        res.end(JSON.stringify(body))
    }
}
