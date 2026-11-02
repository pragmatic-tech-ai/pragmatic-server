import type { IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import type { AdminCapabilitiesDto } from '../../../tenant-types.js'
import { FakeTenantApi, TenantTestHost, TestRail, type FakeDialogService } from '../../../shell/tests/tenant-test-fixtures.js'
import { ConnectionSectionService } from '../../connection/connection-section-service.js'
import { OverviewSectionService } from '../../overview/overview-section-service.js'
import { ReleasesSectionService } from '../../releases/releases-section-service.js'
import { EnvironmentsSectionService } from '../environments-section-service.js'

// Records the versions the adopt wizard was opened on.
export class SpyReleasesSectionService extends ReleasesSectionService
{
    public readonly Adopted: Array<string | undefined> = []

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    public override OpenAdopt(version?: string): void
    {
        this.Adopted.push(version)
    }
}

// A host with Overview, Environments, Connection status and (a spy)
// Releases on a rail, dialogs registered.
export class SectionsFixture
{
    public readonly Host: TenantTestHost
    public readonly Rail: TestRail
    public readonly Dialogs: FakeDialogService

    public constructor(public readonly Api: FakeTenantApi, capabilities: AdminCapabilitiesDto | null = TenantTestHost.AllCapabilities)
    {
        this.Host = new TenantTestHost(Api, capabilities)
        const p = this.Host.Provider
        p.register(OverviewSectionService.Key, (sp) => new OverviewSectionService(sp))
        p.register(EnvironmentsSectionService.Key, (sp) => new EnvironmentsSectionService(sp))
        p.register(ConnectionSectionService.Key, (sp) => new ConnectionSectionService(sp))
        p.registerInstance(ReleasesSectionService.Key, new SpyReleasesSectionService(p))
        this.Dialogs = this.Host.UseDialogs()
        this.Rail = new TestRail(p)
        this.Rail.Add(OverviewSectionService)
        this.Rail.Add(EnvironmentsSectionService)
        this.Rail.Add(ReleasesSectionService)
        this.Rail.Add(ConnectionSectionService)
    }

    public get Overview(): OverviewSectionService
    {
        return this.Host.Provider.getRequired(OverviewSectionService.Key)
    }

    public get Environments(): EnvironmentsSectionService
    {
        return this.Host.Provider.getRequired(EnvironmentsSectionService.Key)
    }

    public get Connection(): ConnectionSectionService
    {
        return this.Host.Provider.getRequired(ConnectionSectionService.Key)
    }

    public get Releases(): SpyReleasesSectionService
    {
        return this.Host.Provider.getRequired(ReleasesSectionService.Key) as SpyReleasesSectionService
    }

    public get Content(): unknown
    {
        return this.Host.Host.Content
    }
}
