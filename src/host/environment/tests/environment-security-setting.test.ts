import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BaseRole, DelegationDepth, IdentityConfig, InvalidSecurityModelError, SecurityModelIssue, SecurityModelIssueCode, Tenant, TenantKind, UnreadableIdpDirectoryRecordError } from '@pragmatic-tech-ai/todl-identity'
import type { IdpDirectorySnapshot, IIdpDirectoryStore, ITenantConfigStore } from '@pragmatic-tech-ai/todl-identity'
import { EnvironmentSecuritySetting } from '../environment-security-setting.js'
import type { ISecuritySettingDiagnostics } from '../environment-security-setting.js'
import { Tier1Fx } from './tier1-fixture.js'

/** A config store whose Get throws `error` (or returns the base setting when none). */
class FaultyConfigStore implements ITenantConfigStore
{
    public constructor(private readonly error: Error | undefined)
    {
    }

    public async Get(_tenantId: string): Promise<IdentityConfig | null>
    {
        if (this.error !== undefined) throw this.error
        return new IdentityConfig(SettingFx.PackId, DelegationDepth.FullAuthz, new Map(), new Map(), new Map(), Tier1Fx.Setting())
    }

    public async Save(): Promise<void>
    {
    }

    public async List(): Promise<readonly string[]>
    {
        return []
    }
}

class FaultyDirectoryStore implements IIdpDirectoryStore
{
    public constructor(private readonly error: Error | undefined)
    {
    }

    public async Get(_tenantId: string): Promise<IdpDirectorySnapshot | null>
    {
        if (this.error !== undefined) throw this.error
        return null
    }

    public async Save(): Promise<void>
    {
    }
}

class CountingDiagnostics implements ISecuritySettingDiagnostics
{
    public readonly Reported: string[] = []

    public Unreadable(_tenantId: string, error: Error): void
    {
        this.Reported.push(error.name)
    }
}

class SettingFx
{
    public static readonly PackId = 'local'
    public static readonly TenantId = 'env1'
    public static readonly Path = 'teams[0].businessUnitId'
    public static readonly Reason = 'unknown business unit: nope'
    public static readonly Tenant = new Tenant(SettingFx.TenantId, TenantKind.SelfHosted, SettingFx.TenantId)

    public static async AssertDenyAll(setting: EnvironmentSecuritySetting): Promise<void>
    {
        const model = await setting.Model()
        assert.deepEqual(model.Config().roleAssignments, [], 'the empty model: nobody holds a role')
        assert.ok(!model.Config().roleAssignments.some(a => a.role === BaseRole.SystemAdministrator))
    }
}

test('invalid stored setting is deny all and reported once', async () =>
{
    const invalid = new InvalidSecurityModelError([new SecurityModelIssue(SecurityModelIssueCode.UnknownBusinessUnit, SettingFx.Path, SettingFx.Reason)])
    const diagnostics = new CountingDiagnostics()
    const setting = new EnvironmentSecuritySetting(new FaultyConfigStore(invalid), new FaultyDirectoryStore(undefined), SettingFx.Tenant, diagnostics)
    await SettingFx.AssertDenyAll(setting)
    await SettingFx.AssertDenyAll(setting)
    assert.deepEqual(diagnostics.Reported, [invalid.name], 'reported once per generation')
    setting.Invalidate()
    await SettingFx.AssertDenyAll(setting)
    assert.equal(diagnostics.Reported.length, 2, 'a new generation reports again')
})

test('an unreadable directory record fails closed too', async () =>
{
    const diagnostics = new CountingDiagnostics()
    const unreadable = new UnreadableIdpDirectoryRecordError(SettingFx.TenantId, SettingFx.Reason)
    const setting = new EnvironmentSecuritySetting(new FaultyConfigStore(undefined), new FaultyDirectoryStore(unreadable), SettingFx.Tenant, diagnostics)
    await SettingFx.AssertDenyAll(setting)
    assert.deepEqual(diagnostics.Reported, [unreadable.name])
})
