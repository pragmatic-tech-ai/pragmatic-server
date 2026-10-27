import { Orientation, StackPanel } from '@pragmatic-tech-ai/mural/basic'
import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { Act, ActVariant, Banner, BannerTone, KitGlyph, ScreenHost, Section, SkeletonKind } from './kit/index.js'
import type { ScreenHostInputs } from './kit/index.js'
import { CreateEnvironmentDialog } from './create-environment-dialog.js'
import { EnvironmentCard } from './environment-card.js'
import { NavSection } from './nav-model.js'
import { OverviewViewModel } from './overview-view-model.js'
import type { IEnvironmentsSource, IOverviewSource, ITenantNavigator, TenantEvent } from './tenant-types.js'
import { TenantApiError } from './tenant-api-client.js'
import { TenantViewBase } from './tenant-view-base.js'

// Tenant admin home: environment cards, a "newer version offered" banner, and a gated Create action.
export class OverviewView extends TenantViewBase
{
    public static readonly Title = 'Overview'
    public static readonly Sub = 'Your environments and what runs in them.'
    public static readonly CreateLabel = 'Create environment'
    public static readonly NeedManage = 'the Manage environments permission'
    public static readonly ReviewLabel = 'Review and adopt'
    public static readonly NeedAdopt = 'the Adopt versions permission'
    public static readonly OfferText = 'A newer version is available. Nothing changes until you choose to adopt.'
    public static readonly OfferVersionPrefix = ' Offered version: '
    public static readonly EmptyTitle = 'No environments yet. Create your first environment.'
    public static readonly ErrorTitle = 'Could not load your environments.'

    private readonly vm: OverviewViewModel
    private readonly subscriptions: IDisposable[] = []
    private readonly body = new StackPanel()
    private readonly dialogHost = new StackPanel()
    private readonly bannerSlot = new StackPanel()
    private readonly cards = new StackPanel()
    private readonly headerSlot = new StackPanel()
    private host: ScreenHost | undefined
    private dialog: CreateEnvironmentDialog | undefined
    private createAct: Act | undefined
    private reviewAct: Act | undefined
    private cardList: EnvironmentCard[] = []
    private banner: Banner | undefined
    private localError: string | undefined

    public constructor(private readonly source: IOverviewSource & IEnvironmentsSource, hiveId: string)
    {
        super()
        this.vm = new OverviewViewModel(source, hiveId)
        this.Orientation = Orientation.Vertical
        for (const panel of [this.body, this.dialogHost, this.bannerSlot, this.cards, this.headerSlot])
        {
            panel.Orientation = Orientation.Vertical
        }
        this.body.AddChild(this.dialogHost)
        this.body.AddChild(this.bannerSlot)
        this.body.AddChild(this.cards)
        this.subscriptions.push(this.vm.PropertyChanged(OverviewViewModel.RowsProperty).subscribe(() => this.Rebuild()))
        this.host = new ScreenHost(this.Inputs())
        this.AddChild(new Section({ title: OverviewView.Title, sub: OverviewView.Sub, actions: this.headerSlot, body: this.host }))
        this.Rebuild()
    }

    // Test seam: the state host (loading / empty / error / populated).
    public get Host(): ScreenHost
    {
        return this.host as ScreenHost
    }

    // Test seam: the header Create action.
    public get CreateAction(): Act
    {
        return this.createAct as Act
    }

    // Test seam: the offer banner's Review-and-adopt action, or undefined when no offer.
    public get ReviewAction(): Act | undefined
    {
        return this.reviewAct
    }

    // Test seam: the offer banner, or undefined when no offer.
    public get OfferBanner(): Banner | undefined
    {
        return this.banner
    }

    // Test seam: the environment cards, in row order.
    public get Cards(): readonly EnvironmentCard[]
    {
        return this.cardList
    }

    // Test seam: the open create dialog, or undefined.
    public get OpenDialog(): CreateEnvironmentDialog | undefined
    {
        return this.dialog
    }

    public override AttachNavigator(nav: ITenantNavigator): void
    {
        super.AttachNavigator(nav)
        // Capabilities are only known once the navigator is attached; undefined is permissive.
        this.Rebuild()
    }

    public async Refresh(): Promise<void>
    {
        this.localError = undefined
        try
        {
            await this.vm.Load()
        }
        catch (e)
        {
            this.ReportError(e)
        }
        this.Rebuild()
    }

    public async ApplyEvent(ev: TenantEvent): Promise<void>
    {
        await this.vm.ApplyEvent(ev)
        this.Rebuild()
    }

    public Dispose(): void
    {
        for (const s of this.subscriptions)
        {
            s.dispose()
        }
        this.subscriptions.length = 0
        this.CloseDialog()
    }

    private get CanManage(): boolean
    {
        return this.Navigator?.Capabilities?.envs !== false
    }

    private get CanAdopt(): boolean
    {
        return this.Navigator?.Capabilities?.adopt !== false
    }

    private MakeCreateAct(): Act
    {
        return new Act({
            can: this.CanManage,
            need: OverviewView.NeedManage,
            onClick: () => this.OpenCreate(),
            label: OverviewView.CreateLabel,
            variant: ActVariant.Primary,
        })
    }

    // A 401 drops to login; every other failure shows through the ScreenHost error state.
    private ReportError(e: unknown): void
    {
        if (e instanceof TenantApiError && e.Status === TenantApiError.UnauthorizedStatus && this.Navigator !== undefined)
        {
            this.ShowError(e)
            return
        }
        this.localError = e instanceof Error ? e.message : String(e)
    }

    private Inputs(): ScreenHostInputs
    {
        const isEmpty = this.vm.Loaded && this.vm.Rows.length === 0
        const failed = this.vm.Error || this.localError !== undefined
        return {
            loading: !this.vm.Loaded && !failed,
            allowed: true,
            isEmpty,
            error: failed,
            skeleton: SkeletonKind.Cards,
            empty: { glyph: KitGlyph.Layers, title: OverviewView.EmptyTitle, action: isEmpty ? this.MakeCreateAct() : undefined },
            errorConfig: failed ? { title: this.localError ?? OverviewView.ErrorTitle } : undefined,
            content: this.body,
        }
    }

    private Rebuild(): void
    {
        this.RebuildHeader()
        this.RebuildBanner()
        this.RebuildCards()
        this.host?.Update(this.Inputs())
    }

    private RebuildHeader(): void
    {
        for (const child of [...this.headerSlot.Children])
        {
            this.headerSlot.RemoveChild(child)
        }
        this.createAct = this.MakeCreateAct()
        this.headerSlot.AddChild(this.createAct)
    }

    private RebuildBanner(): void
    {
        for (const child of [...this.bannerSlot.Children])
        {
            this.bannerSlot.RemoveChild(child)
        }
        this.banner = undefined
        this.reviewAct = undefined
        if (!this.vm.OfferAvailable)
        {
            return
        }
        const version = this.vm.OfferedVersion
        const text = version === undefined ? OverviewView.OfferText : OverviewView.OfferText + OverviewView.OfferVersionPrefix + version
        this.banner = new Banner({ tone: BannerTone.Info, text })
        this.reviewAct = new Act({
            can: this.CanAdopt,
            need: OverviewView.NeedAdopt,
            onClick: () => this.Navigator?.ShowSection(NavSection.Releases),
            label: OverviewView.ReviewLabel,
        })
        this.bannerSlot.AddChild(this.banner)
        this.bannerSlot.AddChild(this.reviewAct)
    }

    private RebuildCards(): void
    {
        for (const child of [...this.cards.Children])
        {
            this.cards.RemoveChild(child)
        }
        this.cardList = []
        for (const row of this.vm.Rows)
        {
            const card = new EnvironmentCard({ row, onOpen: () => this.Navigator?.ShowEnvironmentDetail(row.Dto) })
            this.cardList.push(card)
            this.cards.AddChild(card)
        }
    }

    private OpenCreate(): void
    {
        if (this.dialog !== undefined)
        {
            return
        }
        const dialog = new CreateEnvironmentDialog(this.source, this.vm.ExistingNames, env => this.Navigator?.ShowEnvironmentDetail(env))
        dialog.AddDismissListener(() => this.CloseDialog(dialog))
        this.dialog = dialog
        this.dialogHost.AddChild(dialog)
    }

    private CloseDialog(only?: CreateEnvironmentDialog): void
    {
        if (this.dialog === undefined || (only !== undefined && only !== this.dialog))
        {
            return
        }
        this.dialogHost.RemoveChild(this.dialog)
        this.dialog = undefined
    }
}
