import type { IncomingMessage, ServerResponse } from 'node:http'
import type { IEnvironmentService } from '../control-plane-host.js'
import { EnvironmentDtoMapper } from '../environment-dto.js'
import { HiveDtoMapper } from './hive-dto.js'
import { HiveHealthProducer } from '../hive-health-producer.js'
import type { EnvironmentPlacement } from '../environment-placement.js'
import type { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import { RolloutAdoptionRefusedError, RolloutUnavailableError, type IRolloutClient } from './rollout-client.js'
import type { ITenantDirectory } from './tenant-directory.js'
import type { EnvironmentRecord } from '../environment-record.js'
import { ManifestNotGatedError, UnknownHiveError, UnknownManifestError } from '../rollout-errors.js'
import type { ITenantApiEndpoint } from '../tenant-auth/tenant-plane.js'
import type { TenantSession } from '../tenant-auth/tenant-session.js'

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
    private static readonly TargetSegment = 'target'
    private static readonly HivesPath = TenantApiEndpoint.Prefix + TenantApiEndpoint.HivesSegment
    private static readonly EnvironmentsPath = TenantApiEndpoint.Prefix + TenantApiEndpoint.EnvironmentsSegment
    private static readonly ManifestsPath = TenantApiEndpoint.Prefix + TenantApiEndpoint.ManifestsSegment
    private static readonly HiveSubPathPattern = new RegExp(
        '^' + TenantApiEndpoint.Prefix + TenantApiEndpoint.HivesSegment + '/([^/]+)/(' +
        TenantApiEndpoint.RolloutSegment + '|' + TenantApiEndpoint.HealthSegment + ')$')
    private static readonly HiveTargetPathPattern = new RegExp(
        '^' + TenantApiEndpoint.Prefix + TenantApiEndpoint.HivesSegment + '/([^/]+)/' + TenantApiEndpoint.TargetSegment + '$')
    private static readonly EnvActionPathPattern = new RegExp(
        '^' + TenantApiEndpoint.Prefix + TenantApiEndpoint.EnvironmentsSegment + '/([^/]+)/(' +
        Object.values(TenantEnvAction).join('|') + ')$')
    private static readonly MethodGet = 'GET'
    private static readonly MethodPost = 'POST'
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
    private static readonly StatusNoContent = 204
    private static readonly StatusBadRequest = 400
    private static readonly StatusNotFound = 404
    private static readonly StatusConflict = 409
    private static readonly StatusUnavailable = 503
    private static readonly NotFoundMessage = 'Not found'
    private static readonly BadJsonMessage = 'Request body must be valid JSON'
    private static readonly BodyObjectMessage = 'Request body must be a JSON object'
    private static readonly VersionRequiredMessage = 'version (non-empty string) is required'
    /** The one generic body for a not-gated target: no version id, no engine message, nothing that reveals what was asked for. */
    private static readonly TargetUnavailableMessage = 'Requested version is not available for this hive'
    private static readonly ErrorKey = 'error'

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

    public async Handle(req: IncomingMessage, res: ServerResponse, path: string, session: TenantSession): Promise<boolean>
    {
        const method = req.method ?? TenantApiEndpoint.MethodNone
        if (method === TenantApiEndpoint.MethodGet)
        {
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
        if (err instanceof ManifestNotGatedError || err instanceof RolloutAdoptionRefusedError)
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

    private WriteJson(res: ServerResponse, status: number, body: unknown): void
    {
        res.writeHead(status, { [TenantApiEndpoint.ContentTypeHeader]: TenantApiEndpoint.JsonType })
        res.end(JSON.stringify(body))
    }
}
