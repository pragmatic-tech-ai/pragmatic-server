import { RelayCommand, ServiceBase, ServiceProvider, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { Capability } from '@pragmatic-tech-ai/mural/framework/shell/module.js'
import { ClipboardService } from '@pragmatic-tech-ai/mural/framework/shell/services/clipboard-service.js'
import { ContentHostService } from '@pragmatic-tech-ai/mural/framework/shell/services/content-host-service.js'
import { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import { NavigationDestination, NavigationService } from '@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js'
import type { IActivatable } from '@pragmatic-tech-ai/mural/framework/shell/services/activatable.js'
import type { IDisposable, Observable } from '@pragmatic-tech-ai/todl-runtime'
import { PortalPageViewModel } from './portal-page-view-model.js'
import { PortalSessionService } from './portal-session-service.js'

// One rail section's content service. Owns a small page stack (list -> detail
// -> ...) and presents its top page full-width through the shared
// ContentHostService, but only while it is the active rail section, so an
// off-rail async completion never hijacks the content region. Abstract and
// Key-less; each concrete section declares its own Key and its root page.
export abstract class PortalSectionService extends ServiceBase implements IActivatable
{
    private static readonly CurrentProperty = 'Current'
    private static readonly IsActiveProperty = 'IsActive'
    private static readonly ActiveServiceProperty = 'ActiveService'
    private static readonly BackText = 'Back'

    private readonly pages: Observable[] = []
    private readonly backCommand: RelayCommand
    private active = false
    private activating = false
    private navigationWatched = false
    private navigationSubscription: IDisposable | undefined

    public constructor(provider: IServiceProvider)
    {
        super(provider)
        this.backCommand = new RelayCommand(() => this.Back(), () => this.pages.length > 1, { Text: PortalSectionService.BackText })
    }

    public get Current(): Observable | undefined
    {
        return this.pages.length > 0 ? this.pages[this.pages.length - 1] : undefined
    }

    public get BackCommand(): RelayCommand
    {
        return this.backCommand
    }

    // Whether this section is the rail's active one. Tracks the
    // NavigationService's ActiveService once watched; with no navigation
    // registered (unit tests) the section counts as active.
    public get IsActive(): boolean
    {
        this.WatchNavigation()
        return this.active
    }

    protected get Session(): PortalSessionService
    {
        return this.Provider.getRequired(PortalSessionService.Key)
    }

    // The shell's modal-dialog surface (EditorShell registers it at the app
    // root); undefined before a shell exists.
    public get Dialogs(): DialogService | undefined
    {
        return this.Provider.get(DialogService.Key)
    }

    // The system clipboard seam (registered at the app root); undefined when
    // none is registered.
    public get Clipboard(): ClipboardService | undefined
    {
        return this.Provider.get(ClipboardService.Key)
    }

    private get Host(): ContentHostService
    {
        return this.Provider.getRequired(ContentHostService.Key)
    }

    protected abstract CreateRoot(): PortalPageViewModel

    // Pushes a page and loads it when it is a portal page; shows it only while
    // this section is active (otherwise it shows on the next activation).
    public Present(page: Observable): void
    {
        const old = this.Current
        this.pages.push(page)
        this.ShowAndLoad(old, page)
    }

    // Swaps the top page for `page` (e.g. a one-time reveal for the page it
    // leads to), so Back skips the replaced page.
    public Replace(page: Observable): void
    {
        const old = this.Current
        this.pages.pop()
        this.pages.push(page)
        this.ShowAndLoad(old, page)
    }

    // Presents `page` directly over the root: pops anything above the root,
    // creating (and loading) the root first when the section has none yet.
    public PresentOverRoot(page: Observable): void
    {
        const old = this.Current
        if (this.pages.length === 0)
        {
            const root = this.CreateRoot()
            this.pages.push(root)
            void root.Refresh()
        }
        this.pages.length = 1
        this.pages.push(page)
        this.ShowAndLoad(old, page)
    }

    // Pops to the previous page and reloads it (after the popped page's
    // subject was deleted, say).
    public async BackAndRefresh(): Promise<void>
    {
        this.Back()
        await this.RefreshCurrent()
    }

    // Makes this section the rail's active one by selecting the rail item
    // whose capability names it. False when no rail item does.
    public BringToFront(): boolean
    {
        const navigation = this.Provider.get(NavigationService.Key)
        if (navigation === undefined)
        {
            return false
        }
        for (const item of navigation.Items)
        {
            const capability = item instanceof NavigationDestination ? item.Capability : item
            if (!(capability instanceof Capability) || capability.ServiceKey === undefined)
            {
                continue
            }
            const token = ServiceProvider.tokenFor(capability.ServiceKey as unknown as Function)
            if (this.Provider.get(token) === this)
            {
                navigation.SelectedItem = item
                return true
            }
        }
        return false
    }

    // Pops to the previous page and re-views it. No-op at the root.
    public Back(): void
    {
        if (this.pages.length <= 1)
        {
            return
        }
        const old = this.pages.pop()
        this.ShowCurrent(old)
    }

    // First activation presents the root; later ones re-view the current page
    // (another section may have replaced the shared host's content meanwhile).
    // Navigation is not resolved here: the NavigationService calls this from
    // its own constructor, before it is resolvable.
    public OnActivated(): void
    {
        this.SetActive(true)
        this.activating = true
        try
        {
            const current = this.Current
            if (current === undefined)
            {
                this.Present(this.CreateRoot())
                return
            }
            this.Host.View(current)
        }
        finally
        {
            this.activating = false
        }
    }

    public async RefreshCurrent(): Promise<void>
    {
        const current = this.Current
        if (current instanceof PortalPageViewModel)
        {
            await current.Refresh()
        }
    }

    public override dispose(): void
    {
        this.navigationSubscription?.dispose()
        this.navigationSubscription = undefined
        super.dispose()
    }

    private ShowAndLoad(old: Observable | undefined, page: Observable): void
    {
        this.ShowCurrent(old)
        if (page instanceof PortalPageViewModel)
        {
            void page.Refresh()
        }
    }

    private ShowCurrent(old: Observable | undefined): void
    {
        const current = this.Current
        this.RaisePropertyChanged(PortalSectionService.CurrentProperty, old, current)
        this.backCommand.RaiseCanExecuteChanged()
        if (this.activating || this.IsActive)
        {
            this.Host.View(current)
        }
    }

    // Lazily subscribes to the NavigationService's ActiveService, syncing the
    // active flag from its current value. Once only.
    private WatchNavigation(): void
    {
        if (this.navigationWatched)
        {
            return
        }
        this.navigationWatched = true
        const navigation = this.Provider.get(NavigationService.Key)
        if (navigation === undefined)
        {
            this.SetActive(true)
            return
        }
        this.SetActive(navigation.ActiveService === this)
        this.navigationSubscription = navigation.PropertyChanged(PortalSectionService.ActiveServiceProperty)
            .subscribe(() => this.SetActive(navigation.ActiveService === this))
    }

    private SetActive(next: boolean): void
    {
        const old = this.active
        if (old === next)
        {
            return
        }
        this.active = next
        this.RaisePropertyChanged(PortalSectionService.IsActiveProperty, old, next)
    }
}
