import type { IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { NavigationService, type NavigationDestination } from '@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js'

// The Tenant Admin's rail. Sections present their pages full-width in the content
// region, so the left side pane stays hidden: the stock service reveals it on
// every selection and toggles it on re-click; this subclass forces it closed
// after both. Registered at the app root against NavigationService.Key, so
// EditorShell skips its default.
export class TenantNavigationService extends NavigationService
{
    public constructor(provider: IServiceProvider)
    {
        super(provider)
        this.PopulateFromModules()
        if (this.SelectedItem === undefined && this.Items.Count > 0)
        {
            this.SelectedItem = this.Items.Get(0)
        }
        this.SidePaneVisible = false
    }

    protected override syncActiveService(): void
    {
        super.syncActiveService()
        this.SidePaneVisible = false
    }

    protected override onDestinationActivated(dest: NavigationDestination): void
    {
        super.onDestinationActivated(dest)
        this.SidePaneVisible = false
    }
}
