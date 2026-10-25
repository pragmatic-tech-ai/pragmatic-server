import type { EnvStatus, EnvType, Template, EnvironmentRecord } from './environment-record.js'

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
}

/**
 * Projects a stored EnvironmentRecord into the client-facing EnvironmentDto: connect URLs derived from the host
 * port, no internals or secrets. Shared by the operator surface and the tenant read API so both produce the
 * identical wire shape from one source of truth.
 */
export class EnvironmentDtoMapper
{
    private static readonly HttpScheme = 'http://'
    private static readonly WsScheme = 'ws://'
    private static readonly LocalName = 'localhost'
    private static readonly PortSeparator = ':'
    private static readonly EnvironmentQuery = '/?environment='

    public static ToDto(r: EnvironmentRecord): EnvironmentDto
    {
        const stored = r.endpoint
        return {
            name: r.name,
            template: r.template,
            type: r.type,
            environmentId: r.environmentId,
            hiveId: r.hiveId,
            tenantId: r.tenantId,
            hostPort: r.hostPort,
            status: r.status,
            createdAt: r.createdAt,
            httpUrl: stored?.httpUrl ?? EnvironmentDtoMapper.HttpScheme + EnvironmentDtoMapper.LocalName + EnvironmentDtoMapper.PortSeparator + String(r.hostPort),
            wsUrl: stored?.wsUrl ?? EnvironmentDtoMapper.WsScheme + EnvironmentDtoMapper.LocalName + EnvironmentDtoMapper.PortSeparator + String(r.hostPort) + EnvironmentDtoMapper.EnvironmentQuery + r.environmentId
        }
    }
}
