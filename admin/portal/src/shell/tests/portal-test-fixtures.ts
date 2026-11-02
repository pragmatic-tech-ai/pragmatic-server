import { ServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { ContentHostService } from '@pragmatic-tech-ai/mural/framework/shell/services/content-host-service.js'
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
