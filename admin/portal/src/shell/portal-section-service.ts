import { RelayCommand, ServiceBase, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { ContentHostService } from '@pragmatic-tech-ai/mural/framework/shell/services/content-host-service.js'
import type { IActivatable } from '@pragmatic-tech-ai/mural/framework/shell/services/activatable.js'
import type { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { PortalPageViewModel } from './portal-page-view-model.js'
import { PortalSessionService } from './portal-session-service.js'

// One rail section's content service. Owns a small page stack (list -> detail
// -> ...) and presents its top page full-width through the shared
// ContentHostService. Abstract and Key-less; each concrete section declares
// its own Key and its root page.
export abstract class PortalSectionService extends ServiceBase implements IActivatable
{
    private static readonly CurrentProperty = 'Current'
    private static readonly BackText = 'Back'

    private readonly pages: Observable[] = []
    private readonly backCommand: RelayCommand

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

    protected get Session(): PortalSessionService
    {
        return this.Provider.getRequired(PortalSessionService.Key)
    }

    private get Host(): ContentHostService
    {
        return this.Provider.getRequired(ContentHostService.Key)
    }

    protected abstract CreateRoot(): PortalPageViewModel

    // Pushes a page, shows it, and loads it when it is a portal page.
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
    public OnActivated(): void
    {
        const current = this.Current
        if (current === undefined)
        {
            this.Present(this.CreateRoot())
            return
        }
        this.Host.View(current)
    }

    public async RefreshCurrent(): Promise<void>
    {
        const current = this.Current
        if (current instanceof PortalPageViewModel)
        {
            await current.Refresh()
        }
    }

    private ShowCurrent(old: Observable | undefined): void
    {
        const current = this.Current
        this.RaisePropertyChanged(PortalSectionService.CurrentProperty, old, current)
        this.backCommand.RaiseCanExecuteChanged()
        this.Host.View(current)
    }
}
