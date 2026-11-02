import { RelayCommand, ServiceBase, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { ContentHostService } from '@pragmatic-tech-ai/mural/framework/shell/services/content-host-service.js'
import { NavigationService } from '@pragmatic-tech-ai/mural/framework/shell/services/navigation-service.js'
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
        this.ShowCurrent(old)
        if (page instanceof PortalPageViewModel)
        {
            void page.Refresh()
        }
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
