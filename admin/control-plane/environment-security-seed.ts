import { BaseRole } from '@pragmatic-tech-ai/todl-identity'
import type { SecurityModelDto } from '@pragmatic-tech-ai/pragmatic-protocol'

/** A new Runtime environment could not be given its security setting and administrator; the create is rolled back. */
export class SecuritySeedError extends Error
{
    private static readonly ErrorName = 'SecuritySeedError'
    private static readonly MessagePrefix = 'Environment security seeding failed: '

    public constructor(detail: string)
    {
        super(SecuritySeedError.MessagePrefix + detail)
        this.name = SecuritySeedError.ErrorName
    }
}

/** The security setting a new Runtime environment starts with: one root business unit and its creator as System Administrator (spec 5.1). */
export class EnvironmentSecuritySeed
{
    /** Any id works: the engine accepts exactly one parentless unit as the root. */
    public static readonly RootBusinessUnitId = 'root'
    public static readonly AdministratorRole: string = BaseRole.SystemAdministrator

    public static For(environmentName: string, creatorPrincipalId: string): SecurityModelDto
    {
        const root = EnvironmentSecuritySeed.RootBusinessUnitId
        return {
            businessUnits: [{ id: root, name: environmentName }],
            users: [{ principalId: creatorPrincipalId, businessUnitId: root }],
            teams: [],
            roleAssignments: [{ role: EnvironmentSecuritySeed.AdministratorRole, principalIds: [creatorPrincipalId], teamIds: [] }],
            profileAssignments: [],
            roleOverrides: [],
            profileOverrides: []
        }
    }
}
