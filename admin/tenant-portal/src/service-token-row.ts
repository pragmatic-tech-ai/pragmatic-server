import { PillKind } from './kit/pill-kinds.js'
import type { ServiceTokenSummaryDto } from './tenant-types.js'

// One token line in the Service Tokens list; built fresh on every load.
export class ServiceTokenRow
{
    private static readonly ActiveStatus = 'Active'
    private static readonly ExpiredStatus = 'Expired'
    private static readonly RevokedStatus = 'Revoked'
    private static readonly NeverText = 'Never'
    private static readonly ScopeSeparator = ', '

    public readonly TokenRef: string
    public readonly PrincipalId: string
    public readonly ScopesText: string
    public readonly ExpiresText: string
    public readonly StatusText: string
    public readonly Revoked: boolean
    public readonly PillKind: PillKind

    public constructor(dto: ServiceTokenSummaryDto)
    {
        this.TokenRef = dto.tokenRef
        this.PrincipalId = dto.principalId
        this.Revoked = dto.revoked
        this.ScopesText = dto.scopes.join(ServiceTokenRow.ScopeSeparator)
        this.ExpiresText = dto.expiresAt === null ? ServiceTokenRow.NeverText : dto.expiresAt
        this.StatusText = ServiceTokenRow.StatusOf(dto)
        this.PillKind = ServiceTokenRow.PillKindOf(this.StatusText)
    }

    public static FromDtos(dtos: ServiceTokenSummaryDto[]): ServiceTokenRow[]
    {
        return dtos.map(d => new ServiceTokenRow(d))
    }

    private static PillKindOf(status: string): PillKind
    {
        if (status === ServiceTokenRow.RevokedStatus)
        {
            return PillKind.Revoked
        }
        if (status === ServiceTokenRow.ExpiredStatus)
        {
            return PillKind.Expired
        }
        return PillKind.Active
    }

    private static StatusOf(dto: ServiceTokenSummaryDto): string
    {
        if (dto.revoked)
        {
            return ServiceTokenRow.RevokedStatus
        }
        if (dto.expiresAt !== null && new Date(dto.expiresAt).getTime() < Date.now())
        {
            return ServiceTokenRow.ExpiredStatus
        }
        return ServiceTokenRow.ActiveStatus
    }
}
