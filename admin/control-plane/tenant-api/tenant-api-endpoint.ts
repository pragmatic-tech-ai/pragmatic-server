import type { IncomingMessage, ServerResponse } from 'node:http'
import type { IEnvironmentService } from '../control-plane-host.js'
import { EnvironmentDtoMapper } from '../environment-dto.js'
import { HiveHealthProducer } from '../hive-health-producer.js'
import type { EnvironmentPlacement } from '../environment-placement.js'
import type { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import type { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import type { PlatformDirectory } from '../platform-directory.js'
import type { ITenantApiEndpoint } from '../tenant-auth/tenant-plane.js'
import type { TenantSession } from '../tenant-auth/tenant-session.js'

/**
 * The tenant-plane read API (`/tenant-api/*`). Every route is scoped to the caller's own tenant, taken ONLY from
 * the gate-validated `session.tenantId` — never from a query string or body — so a tenant-A session can never see
 * tenant-B's hives, environments, manifests, rollout or health. The two `:id` routes (rollout, health) answer 404
 * unless the hive is owned by the session's tenant (including when the hive does not exist). The gate has already
 * authenticated the principal, so this endpoint trusts the session and performs authorization (tenant scoping) only.
 */
export class TenantApiEndpoint implements ITenantApiEndpoint
{
    private static readonly Prefix = '/tenant-api/'
    private static readonly HivesSegment = 'hives'
    private static readonly EnvironmentsSegment = 'environments'
    private static readonly ManifestsSegment = 'manifests'
    private static readonly RolloutSegment = 'rollout'
    private static readonly HealthSegment = 'health'
    private static readonly HivesPath = TenantApiEndpoint.Prefix + TenantApiEndpoint.HivesSegment
    private static readonly EnvironmentsPath = TenantApiEndpoint.Prefix + TenantApiEndpoint.EnvironmentsSegment
    private static readonly ManifestsPath = TenantApiEndpoint.Prefix + TenantApiEndpoint.ManifestsSegment
    private static readonly HiveSubPathPattern = new RegExp(
        '^' + TenantApiEndpoint.Prefix + TenantApiEndpoint.HivesSegment + '/([^/]+)/(' +
        TenantApiEndpoint.RolloutSegment + '|' + TenantApiEndpoint.HealthSegment + ')$')
    private static readonly MethodGet = 'GET'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly JsonType = 'application/json; charset=utf-8'
    private static readonly StatusOk = 200
    private static readonly StatusNotFound = 404
    private static readonly NotFoundMessage = 'Not found'
    private static readonly ErrorKey = 'error'

    private readonly health: HiveHealthProducer

    public constructor(
        private readonly service: IEnvironmentService,
        private readonly directory: PlatformDirectory,
        private readonly deployments: PlatformDeploymentRegistry,
        orchestrators: HiveOrchestratorFactory,
        placement: EnvironmentPlacement)
    {
        this.health = new HiveHealthProducer(service, orchestrators, placement)
    }

    public async Handle(req: IncomingMessage, res: ServerResponse, path: string, session: TenantSession): Promise<boolean>
    {
        const method = req.method ?? TenantApiEndpoint.MethodGet
        if (method === TenantApiEndpoint.MethodGet)
        {
            if (path === TenantApiEndpoint.HivesPath)
            {
                this.WriteJson(res, TenantApiEndpoint.StatusOk, this.directory.ListHives(session.tenantId))
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
                this.WriteJson(res, TenantApiEndpoint.StatusOk, [...this.deployments.ManifestsFor(session.tenantId)])
                return true
            }
            const m = TenantApiEndpoint.HiveSubPathPattern.exec(path)
            if (m !== null)
            {
                return await this.RouteHiveSub(res, m, session)
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
            this.WriteJson(res, TenantApiEndpoint.StatusOk, this.deployments.StatusFor(hive.id))
            return true
        }
        this.WriteJson(res, TenantApiEndpoint.StatusOk, await this.health.Produce(hive))
        return true
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
