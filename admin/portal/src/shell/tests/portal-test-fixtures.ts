import { ServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { Capability } from '@pragmatic-tech-ai/mural/framework/shell/module.js'
import { ContentHostService } from '@pragmatic-tech-ai/mural/framework/shell/services/content-host-service.js'
import { NavigationService } from '@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js'
import type { ControlPlaneClient } from '../../api-client.js'
import { OperatorContext } from '../../operator-context.js'
import type { IPageReloader } from '../page-reloader.js'
import { PortalSessionService } from '../portal-session-service.js'

// Counts reloads instead of touching window.location.
export class FakeReloader implements IPageReloader
{
    public Count = 0

    public Reload(): void
    {
        this.Count++
    }
}

// Lets pending promise continuations run.
export class Tick
{
    public static Next(): Promise<void>
    {
        return new Promise(resolve => setImmediate(resolve))
    }
}

// A ServiceProvider with a real ContentHostService and an initialized session.
export class PortalTestHost
{
    public static readonly Email = 'op@example.test'

    public readonly Provider = new ServiceProvider()
    public readonly Reloader = new FakeReloader()
    public readonly Session: PortalSessionService

    public constructor(client: ControlPlaneClient, wireRole: string = OperatorContext.FullWireRole)
    {
        this.Provider.register(ContentHostService.Key, (p) => new ContentHostService(p))
        this.Session = new PortalSessionService(this.Provider)
        this.Session.Initialize(client, PortalTestHost.Email, OperatorContext.FromWire(wireRole), this.Reloader)
        this.Provider.registerInstance(PortalSessionService.Key, this.Session)
    }

    // A host whose client is never called.
    public static WithoutClient(): PortalTestHost
    {
        return new PortalTestHost({} as ControlPlaneClient)
    }

    public get Host(): ContentHostService
    {
        return this.Provider.getRequired(ContentHostService.Key)
    }
}

// A real NavigationService rail over a provider: register section types, then
// Select one to make it the rail's active service (activating it).
export class TestRail
{
    public readonly Navigation: NavigationService

    public constructor(private readonly provider: ServiceProvider)
    {
        this.Navigation = new NavigationService(provider)
        provider.registerInstance(NavigationService.Key, this.Navigation)
    }

    public Select(section: Function): void
    {
        const capability = new Capability()
        capability.ServiceKey = section as never
        this.Navigation.SelectedItem = capability
    }
}
