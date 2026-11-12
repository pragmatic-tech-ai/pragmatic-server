import { before, after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { IEnvironmentCatalog } from '@pragmatic-tech-ai/todl/engine'
import { AccessLevel, BaseRole, IdpDirectorySnapshot, PrivilegeAction } from '@pragmatic-tech-ai/todl-identity'
import type { ISecurityModelConfig } from '@pragmatic-tech-ai/todl-identity'
import { TenantSecurityModel } from '@pragmatic-tech-ai/todl-identity-engine'
import { SecuritySettingCatalogCheck, SecuritySettingIssueCode } from '../security-setting-catalog-check.js'
import { EnvironmentFixture } from './environment-fixture.js'
import { Tier1Fx } from './tier1-fixture.js'

class CheckFx
{
    public static readonly UnknownRole = 'projects.Nope'
    public static readonly UnknownProfile = 'hr.Nope'
    public static readonly UnknownConcept = 'projects.Nope'
    public static readonly UnsecuredField = 'name'

    /** A setting every check accepts: a package-role override and a profile override with their assignments. */
    public static Valid(): ISecurityModelConfig
    {
        return Tier1Fx.Setting({
            RoleAssignments: [
                { role: BaseRole.BasicUser, principalIds: [Tier1Fx.Alice], teamIds: [] },
                { role: Tier1Fx.ProjectManager, principalIds: [Tier1Fx.Pm], teamIds: [] },
                { role: BaseRole.SystemAdministrator, principalIds: [Tier1Fx.Admin], teamIds: [] },
            ],
            RoleOverrides: [Tier1Fx.Override(Tier1Fx.ProjectManager, Tier1Fx.Project, PrivilegeAction.Read, AccessLevel.BusinessUnit)],
            ProfileAssignments: [{ profile: Tier1Fx.Compensation, principalIds: [Tier1Fx.Alice], teamIds: [] }],
            ProfileOverrides: [CheckFx.ProfileOverride(Tier1Fx.Compensation, Tier1Fx.Employee, Tier1Fx.Salary)],
        })
    }

    public static ProfileOverride(profile: string, concept: string, field: string): ISecurityModelConfig['profileOverrides'][number]
    {
        return { profile, concept, field, read: true, update: false, create: false }
    }

    public static Codes(catalog: IEnvironmentCatalog, config: ISecurityModelConfig): SecuritySettingIssueCode[]
    {
        const model = TenantSecurityModel.FromConfig(config, IdpDirectorySnapshot.NonAuthoritative(new Date()))
        return SecuritySettingCatalogCheck.Issues(config, catalog, model).map(issue => issue.Code)
    }

    public static WithOverride(override: ISecurityModelConfig['roleOverrides'][number]): ISecurityModelConfig
    {
        const valid = CheckFx.Valid()
        return { ...valid, roleOverrides: [...valid.roleOverrides, override] }
    }

    public static WithProfileOverride(override: ISecurityModelConfig['profileOverrides'][number]): ISecurityModelConfig
    {
        const valid = CheckFx.Valid()
        return { ...valid, profileOverrides: [...valid.profileOverrides, override] }
    }
}

describe('security setting catalog check', () =>
{
    const fx = new EnvironmentFixture()
    let catalog: IEnvironmentCatalog

    before(async () =>
    {
        for (const [ref, todl] of [[Tier1Fx.Hr, Tier1Fx.HrTodl], [Tier1Fx.Projects, Tier1Fx.ProjectsTodl], [Tier1Fx.Crm, Tier1Fx.CrmTodl], [Tier1Fx.Ext, Tier1Fx.ExtTodl]] as const)
        {
            await fx.Package(ref.id, ref.version, todl)
        }
        fx.Live(Tier1Fx.AppName, Tier1Fx.AppVersion, [Tier1Fx.Hr, Tier1Fx.Projects, Tier1Fx.Crm, Tier1Fx.Ext])
        catalog = (await fx.Host().Snapshot()).Catalog
    })

    after(() => fx.Dispose())

    test('valid setting has no issues', () =>
    {
        assert.deepEqual(CheckFx.Codes(catalog, CheckFx.Valid()), [])
    })

    test('profile override on another package\'s secured field is accepted', () =>
    {
        assert.deepEqual(CheckFx.Codes(catalog, CheckFx.WithProfileOverride(CheckFx.ProfileOverride(Tier1Fx.Staffing, Tier1Fx.Employee, Tier1Fx.Salary))), [], 'PR15')
    })

    test('catalog check rejects an unknown role', () =>
    {
        const valid = CheckFx.Valid()
        const config = { ...valid, roleAssignments: [...valid.roleAssignments, { role: CheckFx.UnknownRole, principalIds: [Tier1Fx.Bob], teamIds: [] }] }
        assert.deepEqual(CheckFx.Codes(catalog, config), [SecuritySettingIssueCode.UnknownRole])
    })

    test('catalog check rejects an unknown profile', () =>
    {
        const valid = CheckFx.Valid()
        const config = { ...valid, profileAssignments: [...valid.profileAssignments, { profile: CheckFx.UnknownProfile, principalIds: [Tier1Fx.Bob], teamIds: [] }] }
        assert.deepEqual(CheckFx.Codes(catalog, config), [SecuritySettingIssueCode.UnknownProfile])
    })

    test('catalog check rejects an unknown concept', () =>
    {
        const config = CheckFx.WithOverride(Tier1Fx.Override(Tier1Fx.ProjectManager, CheckFx.UnknownConcept, PrivilegeAction.Read, AccessLevel.Organization))
        assert.deepEqual(CheckFx.Codes(catalog, config), [SecuritySettingIssueCode.UnknownConcept])
    })

    test('catalog check rejects an unsecured field', () =>
    {
        const config = CheckFx.WithProfileOverride(CheckFx.ProfileOverride(Tier1Fx.Compensation, Tier1Fx.Employee, CheckFx.UnsecuredField))
        assert.deepEqual(CheckFx.Codes(catalog, config), [SecuritySettingIssueCode.UnsecuredField])
    })

    test('catalog check rejects a business-unit depth on an organisation-owned concept', () =>
    {
        const config = CheckFx.WithOverride(Tier1Fx.Override(Tier1Fx.AccountReader, Tier1Fx.Account, PrivilegeAction.Read, AccessLevel.BusinessUnit))
        assert.deepEqual(CheckFx.Codes(catalog, config), [SecuritySettingIssueCode.OrganizationOwnedDepth])
    })

    test('catalog check rejects an override on an external concept', () =>
    {
        const config = CheckFx.WithOverride(Tier1Fx.Override(Tier1Fx.AccountReader, Tier1Fx.Customer, PrivilegeAction.Read, AccessLevel.Organization))
        assert.deepEqual(CheckFx.Codes(catalog, config), [SecuritySettingIssueCode.ExternalConcept])
    })

    test('catalog check rejects a System Administrator override', () =>
    {
        const config = CheckFx.WithOverride(Tier1Fx.Override(BaseRole.SystemAdministrator, Tier1Fx.Employee, PrivilegeAction.Read, AccessLevel.User))
        assert.deepEqual(CheckFx.Codes(catalog, config), [SecuritySettingIssueCode.SystemAdministratorOverride])
    })
})
