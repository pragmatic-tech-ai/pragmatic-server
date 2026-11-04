import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import type { IEnvironmentService } from '../control-plane-host.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import type { HiveRecord, TenantRecord } from '../platform-records.js'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import { DesktopAction, DesktopTargets, type DesktopCapabilitiesSource } from '../tenant-auth/desktop-targets.js'
import { TenantSessionKind, type TenantSession } from '../tenant-auth/tenant-session.js'

/** Only ListReconciled is read by DesktopTargets. */
class ListingService
{
    public constructor(private readonly records: readonly EnvironmentRecord[])
    {
    }

    public async ListReconciled(): Promise<readonly EnvironmentRecord[]>
    {
        return this.records
    }
}

class TargetsDirectory implements ITenantDirectory
{
    public GetTenant(id: string): TenantRecord | undefined
    {
        return { id, clientId: 'c1', displayName: id.toUpperCase(), createdAt: '2026-01-01T00:00:00.000Z', ownerPrincipalId: TargetKit.OwnerId }
    }

    public GetHive(): HiveRecord | undefined
    {
        return undefined
    }

    public ListHives(): readonly HiveRecord[]
    {
        return []
    }
}

class TargetKit
{
    public static readonly TenantId = 'acme'
    public static readonly OtherTenantId = 'globex'
    public static readonly OwnerId = 'owner-1'
    public static readonly Dev = 'acme-dev'
    public static readonly DevStopped = 'acme-dev-stopped'
    public static readonly Run = 'acme-run'
    public static readonly ForeignDev = 'globex-dev'
    public static readonly ForeignRun = 'globex-run'

    public static Record(name: string, tenantId: string, type: EnvType, status: EnvStatus): EnvironmentRecord
    {
        const template = type === EnvType.Development ? Template.DevBlank : Template.RuntimePostgres
        return { name, type, template, environmentId: name, tenantId, createdAt: '2026-10-23T00:00:00.000Z', status }
    }

    public static Session(): TenantSession
    {
        return { id: 'tok', tenantId: TargetKit.TenantId, principalId: TargetKit.OwnerId, expiresAt: '2099-01-01T00:00:00.000Z', kind: TenantSessionKind.Desktop }
    }

    public static Targets(capabilities?: DesktopCapabilitiesSource): DesktopTargets
    {
        const records = [
            TargetKit.Record(TargetKit.Dev, TargetKit.TenantId, EnvType.Development, EnvStatus.Running),
            TargetKit.Record(TargetKit.DevStopped, TargetKit.TenantId, EnvType.Development, EnvStatus.Stopped),
            TargetKit.Record(TargetKit.Run, TargetKit.TenantId, EnvType.Runtime, EnvStatus.Running),
            TargetKit.Record(TargetKit.ForeignDev, TargetKit.OtherTenantId, EnvType.Development, EnvStatus.Running),
            TargetKit.Record(TargetKit.ForeignRun, TargetKit.OtherTenantId, EnvType.Runtime, EnvStatus.Running),
        ]
        return new DesktopTargets(new ListingService(records) as unknown as IEnvironmentService, new TargetsDirectory(), capabilities)
    }
}

describe('DesktopTargets', () =>
{
    it('lists Development envs under contribute only, Runtime under publish only, and never another tenant env', async () =>
    {
        const dto = await TargetKit.Targets().For(TargetKit.Session())
        assert.deepEqual(dto, {
            contribute: [{ name: TargetKit.Dev, status: EnvStatus.Running }, { name: TargetKit.DevStopped, status: EnvStatus.Stopped }],
            publish: [{ name: TargetKit.Run, status: EnvStatus.Running }],
        })
    })

    it('Allows a running env of the right type in the session tenant', async () =>
    {
        const targets = TargetKit.Targets()
        assert.equal((await targets.Allows(TargetKit.Session(), TargetKit.Dev, DesktopAction.Contribute))?.name, TargetKit.Dev)
        assert.equal((await targets.Allows(TargetKit.Session(), TargetKit.Run, DesktopAction.Publish))?.name, TargetKit.Run)
    })

    it('Allows refuses a stopped env, a wrong-type env and a foreign env', async () =>
    {
        const targets = TargetKit.Targets()
        const session = TargetKit.Session()
        assert.equal(await targets.Allows(session, TargetKit.DevStopped, DesktopAction.Contribute), undefined)
        assert.equal(await targets.Allows(session, TargetKit.Dev, DesktopAction.Publish), undefined)
        assert.equal(await targets.Allows(session, TargetKit.Run, DesktopAction.Contribute), undefined)
        assert.equal(await targets.Allows(session, TargetKit.ForeignDev, DesktopAction.Contribute), undefined)
        assert.equal(await targets.Allows(session, TargetKit.ForeignRun, DesktopAction.Publish), undefined)
        assert.equal(await targets.Allows(session, 'missing', DesktopAction.Contribute), undefined)
    })

    it('a role without the environments capability is offered nothing and allowed nothing', async () =>
    {
        const noEnvs: DesktopCapabilitiesSource = () => ({ roleLabel: 'Viewer', capabilities: { envs: false, adopt: false, access: false, settings: false } })
        const targets = TargetKit.Targets(noEnvs)
        assert.deepEqual(await targets.For(TargetKit.Session()), { contribute: [], publish: [] })
        assert.equal(await targets.Allows(TargetKit.Session(), TargetKit.Dev, DesktopAction.Contribute), undefined)
        assert.equal(await targets.Allows(TargetKit.Session(), TargetKit.Run, DesktopAction.Publish), undefined)
    })
})
