import type { EnvStatus, EnvType, Template, EnvironmentRecord } from './environment-record.js'
import { LocalhostUrls } from './environment-runtime.js'

/** The only shape ever sent to a client: connect info, no internals or secrets. */
export type EnvironmentDto = {
    name: string
    template: Template
    type: EnvType
    environmentId: string
    hiveId?: string
    tenantId?: string
    hostPort?: number
    status: EnvStatus
    createdAt: string
    httpUrl: string
    wsUrl: string
    /** Identity of the deployed UI bundle; never its registry coordinates or digest. */
    uiBundle?: { appName: string; appVersion: string }
    /** Base domain of the federated sign-in host, when the environment is federated to its tenant IdP. */
    idpBaseDomain?: string
}

/**
 * Projects a stored EnvironmentRecord into the client-facing EnvironmentDto: connect URLs derived from the host
 * port, no internals or secrets. Shared by the operator surface and the tenant read API so both produce the
 * identical wire shape from one source of truth.
 */
export class EnvironmentDtoMapper
{
    public static ToDto(r: EnvironmentRecord): EnvironmentDto
    {
        const stored = r.endpoint
        const dto: EnvironmentDto = {
            name: r.name,
            template: r.template,
            type: r.type,
            environmentId: r.environmentId,
            hiveId: r.hiveId,
            tenantId: r.tenantId,
            hostPort: r.hostPort,
            status: r.status,
            createdAt: r.createdAt,
            httpUrl: stored?.httpUrl ?? LocalhostUrls.Http(r.hostPort as number),
            wsUrl: stored?.wsUrl ?? LocalhostUrls.Ws(r.hostPort as number, r.environmentId)
        }
        if (r.appDeployment !== undefined)
        {
            dto.uiBundle = { appName: r.appDeployment.appName, appVersion: r.appDeployment.appVersion }
        }
        if (r.idpBaseDomain !== undefined)
        {
            dto.idpBaseDomain = r.idpBaseDomain
        }
        return dto
    }
}
