import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { AdminCapability } from '../../shell/admin-capability.js'
import { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'
import { UtcText } from '../../shell/utc-text.js'
import { ReleasesSnapshot } from './releases-snapshot.js'
import type { LedgerEntry, OfferEntry, VersionEntry } from './releases-snapshot.js'
import type { RolloutEnvDto } from '../../tenant-types.js'

// Where the Releases page sends the operator (its section).
export interface IReleasesNavigator
{
    OpenAdopt(version?: string): void
}

// One offered version as a card: what it is and an Adopt... that opens the
// adopt wizard for it (disabled without the Adopt versions permission).
export class OfferRowViewModel extends Observable
{
    private static readonly PublishedPrefix = 'Published '
    private static readonly AllOnText = 'All environments are on this version.'
    private static readonly OneNotOnText = '1 environment not on this version.'
    private static readonly ManyNotOnTemplate = '{n} environments not on this version.'
    private static readonly CountToken = '{n}'
    private static readonly NoNotes = ''

    private readonly adoptCommand: RelayCommand

    public constructor(private readonly offer: OfferEntry, adopt: RelayCommand)
    {
        super()
        // The page's command decides; the permission it checks is fixed for
        // the session, so the row need not follow its CanExecuteChanged.
        this.adoptCommand = new RelayCommand(() => adopt.Execute(this.Version), () => adopt.CanExecute(this.Version))
    }

    public get Version(): string
    {
        return this.offer.Version
    }

    public get PublishedText(): string
    {
        return OfferRowViewModel.PublishedPrefix + UtcText.Date(this.offer.Manifest.publishedAt)
    }

    public get Notes(): string
    {
        return this.offer.Manifest.notes ?? OfferRowViewModel.NoNotes
    }

    public get HasNotes(): boolean
    {
        return this.Notes.length > 0
    }

    public get NotOnText(): string
    {
        const n = this.offer.NotOnCount
        if (n === 0)
        {
            return OfferRowViewModel.AllOnText
        }
        return n === 1 ? OfferRowViewModel.OneNotOnText : OfferRowViewModel.ManyNotOnTemplate.replace(OfferRowViewModel.CountToken, String(n))
    }

    public get AdoptCommand(): RelayCommand
    {
        return this.adoptCommand
    }
}

// One header cell of the what-runs-where matrix: a version, the current one
// marked.
export class MatrixHeaderCellViewModel extends Observable
{
    private static readonly CurrentSuffix = ' (current)'

    public constructor(private readonly version: VersionEntry)
    {
        super()
    }

    public get Label(): string
    {
        return this.version.IsCurrent ? this.version.Version + MatrixHeaderCellViewModel.CurrentSuffix : this.version.Version
    }
}

// One cell of the matrix: whether the row's environment runs the column's
// version.
export class MatrixCellViewModel extends Observable
{
    private static readonly RunningText = 'Running'
    // An em dash.
    private static readonly NotRunningText = String.fromCharCode(0x2014)

    public constructor(public readonly Version: string, private readonly running: boolean)
    {
        super()
    }

    public get IsRunning(): boolean
    {
        return this.running
    }

    public get IsNotRunning(): boolean
    {
        return !this.running
    }

    public get Text(): string
    {
        return this.running ? MatrixCellViewModel.RunningText : MatrixCellViewModel.NotRunningText
    }
}

// One environment's row of the matrix: a cell per version, in the header's
// (fixed, newest-first) order.
export class MatrixRowViewModel extends Observable
{
    private readonly cells = new ObservableCollection<MatrixCellViewModel>()

    public constructor(private readonly environment: RolloutEnvDto, snapshot: ReleasesSnapshot)
    {
        super()
        for (const version of snapshot.Versions)
        {
            this.cells.Add(new MatrixCellViewModel(version.Version, snapshot.Runs(environment, version)))
        }
    }

    public get Name(): string
    {
        return this.environment.environmentName
    }

    public get Cells(): ObservableCollection<MatrixCellViewModel>
    {
        return this.cells
    }
}

// One Version history row.
export class LedgerRowViewModel extends Observable
{
    public constructor(private readonly entry: LedgerEntry)
    {
        super()
    }

    public get Version(): string
    {
        return this.entry.Version
    }

    public get ActionLabel(): string
    {
        return this.entry.ActionLabel
    }

    public get WhenLabel(): string
    {
        return this.entry.WhenLabel
    }
}

// Releases: the versions Pragmatic offers the hive (each with Adopt...), what
// each environment runs (environment x version), and the hive's version
// history. No offers is the Empty state, as is no hive (with its own text).
export class ReleasesPageViewModel extends TenantPageViewModel
{
    private static readonly OffersProperty = 'Offers'
    private static readonly MatrixHeaderProperty = 'MatrixHeader'
    private static readonly MatrixRowsProperty = 'MatrixRows'
    private static readonly HasMatrixProperty = 'HasMatrix'
    private static readonly LedgerRowsProperty = 'LedgerRows'
    private static readonly HasLedgerProperty = 'HasLedger'
    private static readonly HasNoLedgerProperty = 'HasNoLedger'
    private static readonly HasOffersProperty = 'HasOffers'
    private static readonly HasNoOffersProperty = 'HasNoOffers'
    private static readonly EmptyTextProperty = 'EmptyText'
    private static readonly NoOffersText = 'No new versions offered. New versions arrive when your hive checks in.'
    private static readonly NoHiveText = 'No hive yet. Versions are offered once your hive is installed.'

    private readonly adoptCommand: RelayCommand
    private offers = new ObservableCollection<OfferRowViewModel>()
    private matrixHeader = new ObservableCollection<MatrixHeaderCellViewModel>()
    private matrixRows = new ObservableCollection<MatrixRowViewModel>()
    private ledgerRows = new ObservableCollection<LedgerRowViewModel>()
    private hasHive = true

    public constructor(session: TenantSessionService, private readonly navigator: IReleasesNavigator)
    {
        super(session)
        this.adoptCommand = this.MutatingCommand(AdminCapability.Adopt, async (version) =>
        {
            this.navigator.OpenAdopt(typeof version === 'string' ? version : undefined)
        })
    }

    // Opens the adopt wizard; the parameter is the version to preselect.
    public get AdoptCommand(): RelayCommand
    {
        return this.adoptCommand
    }

    public get Offers(): ObservableCollection<OfferRowViewModel>
    {
        return this.offers
    }

    public get MatrixHeader(): ObservableCollection<MatrixHeaderCellViewModel>
    {
        return this.matrixHeader
    }

    public get MatrixRows(): ObservableCollection<MatrixRowViewModel>
    {
        return this.matrixRows
    }

    public get HasMatrix(): boolean
    {
        return this.matrixRows.Count > 0
    }

    public get LedgerRows(): ObservableCollection<LedgerRowViewModel>
    {
        return this.ledgerRows
    }

    public get HasLedger(): boolean
    {
        return this.ledgerRows.Count > 0
    }

    public get HasNoLedger(): boolean
    {
        return !this.HasLedger
    }

    public get EmptyText(): string
    {
        return this.hasHive ? ReleasesPageViewModel.NoOffersText : ReleasesPageViewModel.NoHiveText
    }

    protected override get PageCapability(): AdminCapability | undefined
    {
        return AdminCapability.Adopt
    }

    protected override async LoadCore(): Promise<boolean>
    {
        const generation = this.LoadGeneration
        const hiveId = await this.Session.ResolveHiveId()
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        if (hiveId === undefined)
        {
            this.Apply(undefined)
            return false
        }
        const snapshot = await ReleasesSnapshot.Load(this.Session.Client, hiveId)
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        this.Apply(snapshot)
        // With a hive the page is populated even without offers: what runs
        // where and the version history still show, and the offers block
        // says nothing new is offered. Only no hive is Empty.
        return true
    }

    public get HasOffers(): boolean
    {
        return this.offers.Count > 0
    }

    public get HasNoOffers(): boolean
    {
        return !this.HasOffers
    }

    // Shown in the offers block when nothing is offered.
    public get NoOffersText(): string
    {
        return ReleasesPageViewModel.NoOffersText
    }

    // Fresh collections each load: each list re-binds in one step.
    private Apply(snapshot: ReleasesSnapshot | undefined): void
    {
        const P = ReleasesPageViewModel
        const before = [this.HasMatrix, this.HasLedger, this.EmptyText, this.HasOffers] as const
        const old = [this.offers, this.matrixHeader, this.matrixRows, this.ledgerRows] as const
        this.hasHive = snapshot !== undefined
        this.offers = new ObservableCollection<OfferRowViewModel>()
        this.matrixHeader = new ObservableCollection<MatrixHeaderCellViewModel>()
        this.matrixRows = new ObservableCollection<MatrixRowViewModel>()
        this.ledgerRows = new ObservableCollection<LedgerRowViewModel>()
        if (snapshot !== undefined)
        {
            for (const offer of snapshot.Offers)
            {
                this.offers.Add(new OfferRowViewModel(offer, this.adoptCommand))
            }
            for (const version of snapshot.Versions)
            {
                this.matrixHeader.Add(new MatrixHeaderCellViewModel(version))
            }
            for (const environment of snapshot.Environments)
            {
                this.matrixRows.Add(new MatrixRowViewModel(environment, snapshot))
            }
            for (const entry of snapshot.Ledger)
            {
                this.ledgerRows.Add(new LedgerRowViewModel(entry))
            }
        }
        this.RaisePropertyChanged(P.OffersProperty, old[0], this.offers)
        this.RaisePropertyChanged(P.MatrixHeaderProperty, old[1], this.matrixHeader)
        this.RaisePropertyChanged(P.MatrixRowsProperty, old[2], this.matrixRows)
        this.RaisePropertyChanged(P.LedgerRowsProperty, old[3], this.ledgerRows)
        this.RaisePropertyChanged(P.HasMatrixProperty, before[0], this.HasMatrix)
        this.RaisePropertyChanged(P.HasLedgerProperty, before[1], this.HasLedger)
        this.RaisePropertyChanged(P.HasNoLedgerProperty, !before[1], this.HasNoLedger)
        this.RaisePropertyChanged(P.EmptyTextProperty, before[2], this.EmptyText)
        this.RaisePropertyChanged(P.HasOffersProperty, before[3], this.HasOffers)
        this.RaisePropertyChanged(P.HasNoOffersProperty, !before[3], this.HasNoOffers)
    }
}
