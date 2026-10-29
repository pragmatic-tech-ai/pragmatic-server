import type { IncomingMessage, ServerResponse } from 'node:http'
import type { IEnvironmentService, MakerTokenDto } from '../control-plane-host.js'
import { EnvironmentDtoMapper } from '../environment-dto.js'
import { TenantAdminCapabilities, type AdminCapabilities } from './tenant-admin-capabilities.js'
import { TenantProfileMapper } from './tenant-profile-dto.js'
import { HiveDtoMapper } from './hive-dto.js'
import { HiveHealthProducer } from '../hive-health-producer.js'
import type { EnvironmentPlacement } from '../environment-placement.js'
import type { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import { RolloutAdoptionRefusedError, RolloutUnavailableError, type IRolloutClient } from './rollout-client.js'
import type { ITenantDirectory } from './tenant-directory.js'
import type { EnvironmentRecord } from '../environment-record.js'
import { ChannelNotSubscribedError, ManifestNotGatedError, ManifestWithdrawnError, TenantOnHoldError, UnknownHiveError, UnknownManifestError, VersionBelowFloorError } from '../rollout-errors.js'
import type { ITenantApiEndpoint } from '../tenant-auth/tenant-plane.js'
import type { TenantSession } from '../tenant-auth/tenant-session.js'
import { AdminProxyError, AdminProxyErrorKind } from '../admin-proxy.js'
import { EnvironmentExistsError, EnvironmentNotDevelopmentError, EnvironmentNotFoundError, EnvironmentNotRuntimeError } from '../environment-service.js'
import { EnvType, Template } from '../environment-record.js'
import { UnsupportedBackendError } from '../hive-orchestrator.js'
import type { CreateAccountParams, GrantMutationDto, IdentityConfigDto, IssueTokenParams, SecurityModelDto } from '@pragmatic-tech-ai/pragmatic-protocol'

/** The lifecycle action a tenant may request against its own environment; the values byte-match the URL path segments. */
export enum TenantEnvAction
{
    Start = 'start',
    Stop = 'stop',
    Restart = 'restart'
}

/**
 * The tenant-plane API (`/tenant-api/*`). Every route is scoped to the caller's own tenant, taken ONLY from the
 * gate-validated `session.tenantId` — never from a query string or body — so a tenant-A session can neither read
 * nor mutate tenant-B's hives, environments, manifests, rollout or health. The `:id`/`:name` routes answer 404
 * (not 403) unless the resource is owned by the session's tenant (including when it does not exist), so existence
 * is never revealed and no cross-tenant action is ever reached. The gate has already authenticated the principal,
 * so this endpoint trusts the session and performs authorization (tenant scoping) only. Mutation errors from the
 * rollout engine are mapped to fixed generic bodies: the version id and other internals never reach the wire.
 */
export class TenantApiEndpoint implements ITenantApiEndpoint
{
    private static readonly Prefix = '/tenant-api/'
    private static readonly HivesSegment = 'hives'
    private static readonly EnvironmentsSegment = 'environments'
    private static readonly ManifestsSegment = 'manifests'
    private static readonly RolloutSegment = 'rollout'
    private static readonly HealthSegment = 'health'
    private static readonly LedgerSegment = 'ledger'
    private static readonly LedgerLimit = 200
    private static readonly TargetSegment = 'target'
    private static readonly ProfileSegment = 'profile'
    private static readonly ProfilePath = TenantApiEndpoint.Prefix + TenantApiEndpoint.ProfileSegment
    private static readonly HivesPath = TenantApiEndpoint.Prefix + TenantApiEndpoint.HivesSegment
    private static readonly EnvironmentsPath = TenantApiEndpoint.Prefix + TenantApiEndpoint.EnvironmentsSegment
    private static readonly ManifestsPath = TenantApiEndpoint.Prefix + TenantApiEndpoint.ManifestsSegment
    private static readonly HiveSubPathPattern = new RegExp(
        '^' + TenantApiEndpoint.Prefix + TenantApiEndpoint.HivesSegment + '/([^/]+)/(' +
        TenantApiEndpoint.RolloutSegment + '|' + TenantApiEndpoint.HealthSegment + '|' + TenantApiEndpoint.LedgerSegment + ')$')
    private static readonly HiveTargetPathPattern = new RegExp(
        '^' + TenantApiEndpoint.Prefix + TenantApiEndpoint.HivesSegment + '/([^/]+)/' + TenantApiEndpoint.TargetSegment + '$')
    private static readonly EnvActionPathPattern = new RegExp(
        '^' + TenantApiEndpoint.Prefix + TenantApiEndpoint.EnvironmentsSegment + '/([^/]+)/(' +
        Object.values(TenantEnvAction).join('|') + ')$')
    /** Matches .../environments/NAME exactly (no trailing segment), so lifecycle-shaped paths never reach Delete. */
    private static readonly EnvNamePathPattern = new RegExp(
        '^' + TenantApiEndpoint.Prefix + TenantApiEndpoint.EnvironmentsSegment + '/([^/]+)$')
    private static readonly AdminSegment = 'admin'
    private static readonly AccessCapability = 'access'
    private static readonly SettingsCapability = 'settings'
    private static readonly SnapshotLeaf = 'snapshot'
    private static readonly AccountsLeaf = 'accounts'
    private static readonly GrantsLeaf = 'grants'
    private static readonly ConfigLeaf = 'config'
    private static readonly SecurityModelLeaf = 'security-model'
    private static readonly TokensLeaf = 'tokens'
    private static readonly MakerTokenLeaf = 'maker-token'
    private static readonly AppReaderLeaf = 'app-reader-grant'
    /** Matches .../environments/NAME/admin/LEAF[/PRINCIPAL] for the per-environment identity-admin surface. */
    private static readonly AdminPathPattern = new RegExp(
        '^' + TenantApiEndpoint.Prefix + TenantApiEndpoint.EnvironmentsSegment + '/([^/]+)/' + TenantApiEndpoint.AdminSegment + '/(' +
        [TenantApiEndpoint.SnapshotLeaf, TenantApiEndpoint.AccountsLeaf, TenantApiEndpoint.GrantsLeaf, TenantApiEndpoint.ConfigLeaf, TenantApiEndpoint.SecurityModelLeaf, TenantApiEndpoint.TokensLeaf].join('|') +
        ')(?:/([^/]+))?$')
    /** Matches .../environments/NAME/(maker-token|app-reader-grant). */
    private static readonly EnvCredentialPathPattern = new RegExp(
        '^' + TenantApiEndpoint.Prefix + TenantApiEndpoint.EnvironmentsSegment + '/([^/]+)/(' +
        TenantApiEndpoint.MakerTokenLeaf + '|' + TenantApiEndpoint.AppReaderLeaf + ')$')
    private static readonly MethodGet = 'GET'
    private static readonly MethodPost = 'POST'
    private static readonly MethodPut = 'PUT'
    private static readonly MethodDelete = 'DELETE'
    /** The fallback for an absent request method: an impossible method so only a real verb matches a route (never mis-serve a methodless request). */
    private static readonly MethodNone = ''
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly JsonType = 'application/json; charset=utf-8'
    private static readonly VersionKey = 'version'
    private static readonly Utf8 = 'utf8'
    private static readonly DataEvent = 'data'
    private static readonly EndEvent = 'end'
    private static readonly ErrorEvent = 'error'
    /** A target-selection body carries only { version }; nothing legitimate is larger, so anything bigger is rejected as invalid. */
    private static readonly MaxBodyBytes = 4096
    private static readonly StatusOk = 200
    private static readonly StatusCreated = 201
    private static readonly StatusNoContent = 204
    private static readonly StatusBadRequest = 400
    private static readonly StatusNotFound = 404
    private static readonly StatusForbidden = 403
    private static readonly ForbiddenMessage = 'forbidden'
    private static readonly StatusConflict = 409
    private static readonly StatusInternal = 500
    private static readonly StatusUnavailable = 503
    private static readonly NotFoundMessage = 'Not found'
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

    private readonly health: HiveHealthProducer

    public constructor(
        private readonly service: IEnvironmentService,
        private readonly directory: ITenantDirectory,
        private readonly rolloutClient: IRolloutClient,
        orchestrators: HiveOrchestratorFactory,
        placement: EnvironmentPlacement)
    {
        this.health = new HiveHealthProducer(service, orchestrators, placement)
    }

    private RouteProfile(res: ServerResponse, session: TenantSession): void
    {
        const tenant = this.directory.GetTenant(session.tenantId)
        const hive = this.directory.ListHives(session.tenantId)[0]
        const dto = TenantProfileMapper.ToDto(session, tenant, hive, this.directory.GetOrganisation?.(session.tenantId), TenantAdminCapabilities.For(session, tenant))
        this.WriteJson(res, TenantApiEndpoint.StatusOk, dto)
    }

    public async Handle(req: IncomingMessage, res: ServerResponse, path: string, session: TenantSession): Promise<boolean>
    {
        const method = req.method ?? TenantApiEndpoint.MethodNone
        if (method === TenantApiEndpoint.MethodGet)
        {
            if (path === TenantApiEndpoint.ProfilePath)
            {
                this.RouteProfile(res, session)
                return true
            }
            if (path === TenantApiEndpoint.HivesPath)
            {
                this.WriteJson(res, TenantApiEndpoint.StatusOk, this.directory.ListHives(session.tenantId).map(h => HiveDtoMapper.ToDto(h)))
                return true
            }
            if (path === TenantApiEndpoint.EnvironmentsPath)
            {
                const dtos = (await this.service.ListReconciled())
                    .filter(r => r.tenantId === session.tenantId)
                    .map(r => EnvironmentDtoMapper.ToDto(r))
                this.WriteJson(res, TenantApiEndpoint.StatusOk, dtos)
                return true
            }
            if (path === TenantApiEndpoint.ManifestsPath)
            {
                try
                {
                    this.WriteJson(res, TenantApiEndpoint.StatusOk, [...await this.rolloutClient.ManifestsFor(session.tenantId)])
                }
                catch (err)
                {
                    return this.WriteRolloutError(res, err)
                }
                return true
            }
            const m = TenantApiEndpoint.HiveSubPathPattern.exec(path)
            if (m !== null)
            {
                return await this.RouteHiveSub(res, m, session)
            }
        }
        if (method === TenantApiEndpoint.MethodPost)
        {
            if (path === TenantApiEndpoint.EnvironmentsPath)
            {
                return await this.RouteEnvCreate(req, res, session)
            }
            const tm = TenantApiEndpoint.HiveTargetPathPattern.exec(path)
            if (tm !== null)
            {
                return await this.RouteHiveTarget(req, res, tm, session)
            }
            const em = TenantApiEndpoint.EnvActionPathPattern.exec(path)
            if (em !== null)
            {
                return await this.RouteEnvAction(res, em, session)
            }
        }
        if (method === TenantApiEndpoint.MethodDelete)
        {
            const dm = TenantApiEndpoint.EnvNamePathPattern.exec(path)
            if (dm !== null)
            {
                return await this.RouteEnvDelete(res, dm, session)
            }
        }
        const adm = TenantApiEndpoint.AdminPathPattern.exec(path)
        if (adm !== null)
        {
            return await this.RouteAdmin(req, res, method, adm, session)
        }
        const cm = TenantApiEndpoint.EnvCredentialPathPattern.exec(path)
        if (cm !== null && method === TenantApiEndpoint.MethodPost)
        {
            return await this.RouteEnvCredential(res, cm, session)
        }
        // Any other method/path under /tenant-api/* is handled here (the gate expects an answer), as a 404.
        this.WriteNotFound(res)
        return true
    }

    /** Serves the tenant's own hive rollout/health; 404 (not 403) when the hive is unknown or owned by another tenant, so existence is never revealed. */
    private async RouteHiveSub(res: ServerResponse, m: RegExpExecArray, session: TenantSession): Promise<boolean>
    {
        const id = TenantApiEndpoint.Decode(m[1] as string)
        const sub = m[2] as string
        const hive = id === undefined ? undefined : this.directory.GetHive(id)
        if (hive === undefined || hive.tenantId !== session.tenantId)
        {
            this.WriteNotFound(res)
            return true
        }
        if (sub === TenantApiEndpoint.RolloutSegment)
        {
            try
            {
                this.WriteJson(res, TenantApiEndpoint.StatusOk, await this.rolloutClient.StatusFor(hive.id))
            }
            catch (err)
            {
                return this.WriteRolloutError(res, err)
            }
            return true
        }
        if (sub === TenantApiEndpoint.LedgerSegment)
        {
            this.WriteJson(res, TenantApiEndpoint.StatusOk, [...await this.rolloutClient.LedgerFor(hive.id, TenantApiEndpoint.LedgerLimit)])
            return true
        }
        this.WriteJson(res, TenantApiEndpoint.StatusOk, await this.health.Produce(hive))
        return true
    }

    /**
     * Rolls the tenant's own hive to a published version. The ownership guard runs before anything else, so an unknown
     * or cross-tenant hive 404s without the body being read or `SelectTarget` ever being called. A not-gated version →
     * 409 and an unknown version → 404, both with a fixed generic body (no version id, no engine message); any other
     * error bubbles to the host's generic error writer.
     */
    private async RouteHiveTarget(req: IncomingMessage, res: ServerResponse, m: RegExpExecArray, session: TenantSession): Promise<boolean>
    {
        const id = TenantApiEndpoint.Decode(m[1] as string)
        const hive = id === undefined ? undefined : this.directory.GetHive(id)
        if (hive === undefined || hive.tenantId !== session.tenantId)
        {
            this.WriteNotFound(res)
            return true
        }
        const version = await this.ReadVersion(req, res)
        if (version === undefined)
        {
            return true
        }
        try
        {
            await this.rolloutClient.AdoptTarget(hive.id, version)
        }
        catch (err)
        {
            return this.WriteTargetError(res, err)
        }
        res.writeHead(TenantApiEndpoint.StatusNoContent)
        res.end()
        return true
    }

    /** Maps the rollout engine's selection errors to fixed generic bodies; rethrows anything else so the host's generic writer answers. */
    private WriteTargetError(res: ServerResponse, err: unknown): boolean
    {
        if (err instanceof RolloutUnavailableError)
        {
            return this.WriteRolloutError(res, err)
        }
        if (err instanceof ManifestNotGatedError || err instanceof RolloutAdoptionRefusedError || err instanceof ManifestWithdrawnError || err instanceof TenantOnHoldError || err instanceof ChannelNotSubscribedError || err instanceof VersionBelowFloorError)
        {
            this.WriteJson(res, TenantApiEndpoint.StatusConflict, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.TargetUnavailableMessage })
            return true
        }
        if (err instanceof UnknownManifestError || err instanceof UnknownHiveError)
        {
            this.WriteNotFound(res)
            return true
        }
        throw err
    }

    /** A rollout client with no operator link answers 503 with its clear message; anything else rethrows to the host's generic writer. */
    private WriteRolloutError(res: ServerResponse, err: unknown): boolean
    {
        if (err instanceof RolloutUnavailableError)
        {
            this.WriteJson(res, TenantApiEndpoint.StatusUnavailable, { [TenantApiEndpoint.ErrorKey]: err.message })
            return true
        }
        throw err
    }

    /** Starts/stops/restarts the tenant's own environment; 404 (not 403) when the env is unknown or owned by another tenant, so the service action is never reached. */
    private async RouteEnvAction(res: ServerResponse, m: RegExpExecArray, session: TenantSession): Promise<boolean>
    {
        const name = TenantApiEndpoint.Decode(m[1] as string)
        const action = m[2] as TenantEnvAction
        const rec = name === undefined ? undefined : this.service.List().find(r => r.name === name)
        if (rec === undefined || rec.tenantId !== session.tenantId)
        {
            this.WriteNotFound(res)
            return true
        }
        const updated = await this.Perform(action, rec.name)
        this.WriteJson(res, TenantApiEndpoint.StatusOk, EnvironmentDtoMapper.ToDto(updated))
        return true
    }

    /** Deletes the tenant's own environment (204); 404 (not 403) when unknown or owned by another tenant, so existence is never revealed and the service Delete is never reached. No capability gate: every admin role has envs, same as the lifecycle routes. */
    private async RouteEnvDelete(res: ServerResponse, m: RegExpExecArray, session: TenantSession): Promise<boolean>
    {
        const name = TenantApiEndpoint.Decode(m[1] as string)
        const rec = name === undefined ? undefined : this.service.List().find(r => r.name === name)
        if (rec === undefined || rec.tenantId !== session.tenantId)
        {
            this.WriteNotFound(res)
            return true
        }
        await this.service.Delete(rec.name)
        res.writeHead(TenantApiEndpoint.StatusNoContent)
        res.end()
        return true
    }

    /**
     * Creates an environment in the caller's own hive. The hive is derived ONLY from `session.tenantId` via the
     * directory (one hive per tenant) - the body is never consulted for a hive or tenant, so it cannot steer creation
     * cross-tenant. The body is validated before anything is created; failures map to fixed generic bodies.
     */
    private async RouteEnvCreate(req: IncomingMessage, res: ServerResponse, session: TenantSession): Promise<boolean>
    {
        const body = await this.ReadObject(req, res)
        if (body === undefined)
        {
            return true
        }
        const name = body[TenantApiEndpoint.NameKey]
        const template = body[TenantApiEndpoint.TemplateKey]
        const type = body[TenantApiEndpoint.TypeKey]
        if (typeof name !== 'string' || name.length === 0
            || !Object.values(Template).includes(template as Template)
            || !Object.values(EnvType).includes(type as EnvType))
        {
            this.WriteJson(res, TenantApiEndpoint.StatusBadRequest, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.CreateFieldsMessage })
            return true
        }
        const hive = this.directory.ListHives(session.tenantId)[0]
        if (hive === undefined)
        {
            this.WriteJson(res, TenantApiEndpoint.StatusConflict, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.NoHiveMessage })
            return true
        }
        try
        {
            const record = await this.service.Create(name, template as Template, type as EnvType, undefined, hive.id)
            this.WriteJson(res, TenantApiEndpoint.StatusCreated, EnvironmentDtoMapper.ToDto(record))
        }
        catch (err)
        {
            this.WriteCreateError(res, err)
        }
        return true
    }

    /** Maps a create failure to a fixed status and a fixed generic body; the caught error (and its text) is never echoed. */
    private WriteCreateError(res: ServerResponse, err: unknown): void
    {
        let status = TenantApiEndpoint.StatusInternal
        let message = TenantApiEndpoint.CreateFailedMessage
        if (err instanceof EnvironmentExistsError)
        {
            status = TenantApiEndpoint.StatusConflict
            message = TenantApiEndpoint.CreateExistsMessage
        }
        else if (err instanceof UnsupportedBackendError)
        {
            status = TenantApiEndpoint.StatusBadRequest
            message = TenantApiEndpoint.CreateUnsupportedMessage
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

    /** Resolves the env record only when it belongs to the session's tenant; undefined (to be answered 404, never 403) for unknown, malformed, or cross-tenant names. */
    private OwnedEnv(rawName: string, session: TenantSession): EnvironmentRecord | undefined
    {
        const name = TenantApiEndpoint.Decode(rawName)
        const rec = name === undefined ? undefined : this.service.List().find(r => r.name === name)
        return rec === undefined || rec.tenantId !== session.tenantId ? undefined : rec
    }

    /** Dispatches the per-environment identity-admin routes; the ownership guard runs first, so a foreign env 404s before any body is read or service call made. */
    private async RouteAdmin(req: IncomingMessage, res: ServerResponse, method: string, m: RegExpExecArray, session: TenantSession): Promise<boolean>
    {
        const rec = this.OwnedEnv(m[1] as string, session)
        if (rec === undefined)
        {
            this.WriteNotFound(res)
            return true
        }
        try
        {
            const required = TenantApiEndpoint.RequiredCapability(method, m[2] as string, m[3])
            if (required !== undefined && !this.RequireCapability(res, session, required))
            {
                return true
            }
            if (!await this.DispatchAdmin(req, res, method, rec.name, m[2] as string, m[3]))
            {
                this.WriteNotFound(res)
            }
        }
        catch (err)
        {
            this.WriteIdentityError(res, err)
        }
        return true
    }

    /**
     * The single audit point for capability enforcement: which admin write routes need which capability. GETs, environment
     * lifecycle/create, hive target and the env credential routes are deliberately absent (open to any tenant admin).
     */
    private static RequiredCapability(method: string, leaf: string, tail: string | undefined): keyof AdminCapabilities | undefined
    {
        const M = TenantApiEndpoint
        if (tail !== undefined)
        {
            return leaf === M.AccountsLeaf && method === M.MethodDelete ? M.AccessCapability : undefined
        }
        if (leaf === M.AccountsLeaf)
        {
            return method === M.MethodPost ? M.AccessCapability : undefined
        }
        if (leaf === M.TokensLeaf || leaf === M.GrantsLeaf)
        {
            return method === M.MethodPost || method === M.MethodDelete ? M.AccessCapability : undefined
        }
        if (leaf === M.SecurityModelLeaf)
        {
            return method === M.MethodPut ? M.AccessCapability : undefined
        }
        if (leaf === M.ConfigLeaf)
        {
            return method === M.MethodPut ? M.SettingsCapability : undefined
        }
        return undefined
    }

    /** Honesty invariant: derives capabilities via the SAME TenantAdminCapabilities.For the profile route reports; writes a generic 403 and returns false when missing. */
    private RequireCapability(res: ServerResponse, session: TenantSession, capability: keyof AdminCapabilities): boolean
    {
        const caps = TenantAdminCapabilities.For(session, this.directory.GetTenant(session.tenantId)).capabilities
        if (caps[capability])
        {
            return true
        }
        this.WriteJson(res, TenantApiEndpoint.StatusForbidden, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.ForbiddenMessage })
        return false
    }

    /** Runs one admin (leaf, method, tail) combination; false when the combination is not a route. */
    private async DispatchAdmin(req: IncomingMessage, res: ServerResponse, method: string, name: string, leaf: string, tail: string | undefined): Promise<boolean>
    {
        if (method === TenantApiEndpoint.MethodGet && tail === undefined)
        {
            return await this.AdminRead(res, name, leaf)
        }
        if (leaf === TenantApiEndpoint.AccountsLeaf && tail !== undefined && method === TenantApiEndpoint.MethodDelete)
        {
            const principalId = TenantApiEndpoint.Decode(tail)
            if (principalId === undefined)
            {
                this.WriteNotFound(res)
                return true
            }
            await this.service.AdminDisableAccount(name, principalId)
            this.WriteJson(res, TenantApiEndpoint.StatusOk, { [TenantApiEndpoint.OkKey]: true })
            return true
        }
        if (tail !== undefined)
        {
            return false
        }
        if (leaf === TenantApiEndpoint.AccountsLeaf && method === TenantApiEndpoint.MethodPost)
        {
            return await this.AdminCreateAccount(req, res, name)
        }
        if (leaf === TenantApiEndpoint.GrantsLeaf && (method === TenantApiEndpoint.MethodPost || method === TenantApiEndpoint.MethodDelete))
        {
            return await this.AdminGrant(req, res, name, method === TenantApiEndpoint.MethodPost)
        }
        if (leaf === TenantApiEndpoint.TokensLeaf && method === TenantApiEndpoint.MethodPost)
        {
            return await this.AdminIssueToken(req, res, name)
        }
        if (leaf === TenantApiEndpoint.TokensLeaf && method === TenantApiEndpoint.MethodDelete)
        {
            return await this.AdminRevokeToken(req, res, name)
        }
        if (leaf === TenantApiEndpoint.SecurityModelLeaf && method === TenantApiEndpoint.MethodPut)
        {
            return await this.AdminSetSecurityModel(req, res, name)
        }
        if (leaf === TenantApiEndpoint.ConfigLeaf && method === TenantApiEndpoint.MethodPut)
        {
            return await this.AdminSetConfig(req, res, name)
        }
        return false
    }

    /** Serves the three identity-admin reads (snapshot, config, security model); false for any other leaf. */
    private async AdminRead(res: ServerResponse, name: string, leaf: string): Promise<boolean>
    {
        if (leaf === TenantApiEndpoint.SnapshotLeaf)
        {
            this.WriteJson(res, TenantApiEndpoint.StatusOk, await this.service.AdminSnapshot(name))
            return true
        }
        if (leaf === TenantApiEndpoint.ConfigLeaf)
        {
            this.WriteJson(res, TenantApiEndpoint.StatusOk, await this.service.AdminGetConfig(name))
            return true
        }
        if (leaf === TenantApiEndpoint.TokensLeaf)
        {
            this.WriteJson(res, TenantApiEndpoint.StatusOk, await this.service.AdminListTokens(name))
            return true
        }
        if (leaf === TenantApiEndpoint.SecurityModelLeaf)
        {
            // JSON null (not undefined) so the body is always valid JSON when no model is stored.
            this.WriteJson(res, TenantApiEndpoint.StatusOk, await this.service.AdminGetSecurityModel(name) ?? null)
            return true
        }
        return false
    }

    private async AdminCreateAccount(req: IncomingMessage, res: ServerResponse, name: string): Promise<boolean>
    {
        const body = await this.ReadObject(req, res)
        if (body === undefined)
        {
            return true
        }
        if (!TenantApiEndpoint.NonEmpty(body.email) || !TenantApiEndpoint.NonEmpty(body.principalId) || !TenantApiEndpoint.NonEmpty(body.password))
        {
            this.WriteJson(res, TenantApiEndpoint.StatusBadRequest, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.AccountFieldsMessage })
            return true
        }
        const account = { email: body.email, principalId: body.principalId, password: body.password } as unknown as CreateAccountParams
        await this.service.AdminCreateAccount(name, account)
        this.WriteJson(res, TenantApiEndpoint.StatusCreated, { [TenantApiEndpoint.OkKey]: true })
        return true
    }

    /** Issues a service token; the secret is returned only here, never cached. */
    private async AdminIssueToken(req: IncomingMessage, res: ServerResponse, name: string): Promise<boolean>
    {
        const body = await this.ReadObject(req, res)
        if (body === undefined)
        {
            return true
        }
        const expires = body.expiresInSeconds
        const scopes = body.scopes
        const scopesOk = Array.isArray(scopes) && scopes.length > 0 && scopes.every(x => TenantApiEndpoint.NonEmpty(x) && (x as string).trim().length > 0)
        const expiresOk = expires === undefined || expires === null || (typeof expires === 'number' && Number.isInteger(expires) && expires > 0)
        if (!TenantApiEndpoint.NonEmpty(body.principalId) || !scopesOk || !expiresOk)
        {
            this.WriteJson(res, TenantApiEndpoint.StatusBadRequest, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.TokenIssueFieldsMessage })
            return true
        }
        const params = { principalId: body.principalId, scopes: (scopes as string[]).map(x => x.trim()), expiresInSeconds: expires ?? null } as unknown as IssueTokenParams
        const issued = await this.service.AdminIssueToken(name, params)
        this.WriteJson(res, TenantApiEndpoint.StatusCreated, issued, { [TenantApiEndpoint.CacheControlHeader]: TenantApiEndpoint.NoStore })
        return true
    }

    /** Revokes a service token; the tokenRef travels in the body because it contains slashes. */
    private async AdminRevokeToken(req: IncomingMessage, res: ServerResponse, name: string): Promise<boolean>
    {
        const body = await this.ReadObject(req, res)
        if (body === undefined)
        {
            return true
        }
        if (!TenantApiEndpoint.NonEmpty(body.tokenRef))
        {
            this.WriteJson(res, TenantApiEndpoint.StatusBadRequest, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.TokenRefMessage })
            return true
        }
        await this.service.AdminRevokeToken(name, body.tokenRef as string)
        this.WriteJson(res, TenantApiEndpoint.StatusOk, { [TenantApiEndpoint.OkKey]: true })
        return true
    }

    /** POST grants a role, DELETE revokes it; both read the same `{ subject, role, resourceKind?, resourcePath? }` body. */
    private async AdminGrant(req: IncomingMessage, res: ServerResponse, name: string, grant: boolean): Promise<boolean>
    {
        const body = await this.ReadObject(req, res)
        if (body === undefined)
        {
            return true
        }
        if (typeof body.subject !== 'string' || typeof body.role !== 'string')
        {
            this.WriteJson(res, TenantApiEndpoint.StatusBadRequest, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.GrantFieldsMessage })
            return true
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
        return true
    }

    private async AdminSetSecurityModel(req: IncomingMessage, res: ServerResponse, name: string): Promise<boolean>
    {
        const body = await this.ReadObject(req, res)
        if (body === undefined)
        {
            return true
        }
        if (typeof body.securityModel !== 'object' || body.securityModel === null)
        {
            this.WriteJson(res, TenantApiEndpoint.StatusBadRequest, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.SecurityModelFieldMessage })
            return true
        }
        await this.service.AdminSetSecurityModel(name, body.securityModel as SecurityModelDto)
        this.WriteJson(res, TenantApiEndpoint.StatusOk, { [TenantApiEndpoint.OkKey]: true })
        return true
    }

    private async AdminSetConfig(req: IncomingMessage, res: ServerResponse, name: string): Promise<boolean>
    {
        const body = await this.ReadObject(req, res)
        if (body === undefined)
        {
            return true
        }
        if (typeof body.packId !== 'string' || typeof body.delegationDepth !== 'string')
        {
            this.WriteJson(res, TenantApiEndpoint.StatusBadRequest, { [TenantApiEndpoint.ErrorKey]: TenantApiEndpoint.ConfigFieldsMessage })
            return true
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
        return true
    }

    /** POST maker-token (201 + the once-only token DTO) and POST app-reader-grant (200 { ok }, no secret) on the tenant's own environment. */
    private async RouteEnvCredential(res: ServerResponse, m: RegExpExecArray, session: TenantSession): Promise<boolean>
    {
        const rec = this.OwnedEnv(m[1] as string, session)
        if (rec === undefined)
        {
            this.WriteNotFound(res)
            return true
        }
        try
        {
            if (m[2] === TenantApiEndpoint.MakerTokenLeaf)
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
        return true
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

    /** Collects the request body (capped); an over-large body resolves empty so it fails JSON parsing and is answered as a 400. */
    private static ReadBody(req: IncomingMessage): Promise<string>
    {
        return new Promise((resolveBody, reject) =>
        {
            const chunks: Buffer[] = []
            let size = 0
            let tooLarge = false
            req.on(TenantApiEndpoint.DataEvent, (c: Buffer) =>
            {
                size += c.length
                if (size > TenantApiEndpoint.MaxBodyBytes)
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

    private static Decode(segment: string): string | undefined
    {
        try
        {
            return decodeURIComponent(segment)
        }
        catch
        {
            return undefined
        }
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
