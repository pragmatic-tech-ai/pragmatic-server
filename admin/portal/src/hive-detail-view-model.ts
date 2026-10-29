import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { FleetHiveDto, LedgerDto, ObservationDto } from './portal-types.js'
import { PortalDates } from './portal-dates.js'
import { FleetConnection, FleetViewModel } from './fleet-view-model.js'
import type { FleetRow } from './fleet-view-model.js'
import type { ObservedEnvRow } from './observed-env-table.js'
import { FleetPresentation } from './fleet-presentation.js'
import { BannerTone, PillKinds } from './kit/index.js'
import type { KeyValueItem } from './kit/index.js'

export interface ObservationHistoryRow
{
    whenLabel: string
    summaryLabel: string
}

export interface LedgerRow
{
    whenLabel: string
    actionLabel: string
    version: string
}

export interface HiveBannerState
{
    show: boolean
    tone: BannerTone
    text: string
}

// Pure derivation for the hive detail page: fleet row, banner, home channel, observed envs.
export class HiveDetailViewModel extends Observable
{
    private static readonly ClusterSeparator = ' / '
    private static readonly NameToken = '{name}'
    private static readonly QuietTemplate =
        '{name} has not checked in for a while. Its last report stands. Pragmatic cannot connect in, so there is nothing to retry from here.'
    private static readonly AwaitingText = 'Awaiting first dial-in.'
    private static readonly NoText = ''
    private static readonly NoImage = '-'
    private static readonly SummaryTemplate = '{ready}/{total} ready'
    private static readonly ReadyToken = '{ready}'
    private static readonly TotalToken = '{total}'
    private static readonly KeyOwner = 'Client / tenant'
    private static readonly KeyConnection = 'Connection'
    private static readonly KeyLastCheckIn = 'Last check-in'
    private static readonly KeyCluster = 'Cluster'
    private static readonly KeyEnvironments = 'Environments observed'

    private static readonly ActionLabels: Readonly<Record<string, string>> = {
        gated: 'Gated',
        ungated: 'Ungated',
        withdrawn: 'Withdrawn',
        restored: 'Restored',
        selected: 'Selected as target',
        adopted: 'Adopted',
    }

    private readonly cluster: string
    private readonly row: FleetRow
    private readonly banner: HiveBannerState
    private readonly homeChannel: readonly KeyValueItem[]
    private readonly envRows: readonly ObservedEnvRow[]
    private readonly history: readonly ObservationHistoryRow[]
    private readonly ledgerRows: readonly LedgerRow[]

    public constructor(
        private readonly hive: FleetHiveDto,
        now: () => Date = () => new Date(),
        quietThresholdMs?: number,
        observations: readonly ObservationDto[] = [],
        ledger: readonly LedgerDto[] = [],
    )
    {
        super()
        this.row = new FleetViewModel([hive], now, quietThresholdMs).Rows[0]
        this.cluster = hive.clusterBackend + HiveDetailViewModel.ClusterSeparator + hive.clusterMode
        this.banner = this.DeriveBanner()
        const connectionLabel = PillKinds.For(FleetPresentation.ConnectionKind(this.row.connection)).label
        this.homeChannel = [
            { key: HiveDetailViewModel.KeyOwner, value: this.OwnerLabel },
            { key: HiveDetailViewModel.KeyConnection, value: connectionLabel },
            { key: HiveDetailViewModel.KeyLastCheckIn, value: this.row.lastSeenLabel },
            { key: HiveDetailViewModel.KeyCluster, value: this.cluster },
            { key: HiveDetailViewModel.KeyEnvironments, value: String(this.row.envCount) },
        ]
        this.envRows = hive.environments.map(e => ({
            name: e.name,
            ready: e.ready,
            image: e.image ?? HiveDetailViewModel.NoImage,
            detail: e.detail,
        }))
        this.history = observations.map(o => ({
            whenLabel: PortalDates.Label(o.reportedAt),
            summaryLabel: HiveDetailViewModel.Summarize(o),
        }))
        this.ledgerRows = ledger.map(l => ({
            whenLabel: PortalDates.Label(l.at),
            actionLabel: HiveDetailViewModel.ActionLabels[l.action] ?? l.action,
            version: l.version,
        }))
    }

    public get Hive(): FleetHiveDto
    {
        return this.hive
    }

    public get OwnerLabel(): string
    {
        return this.row.ownerLabel
    }

    public get Cluster(): string
    {
        return this.cluster
    }

    public get Connection(): FleetConnection
    {
        return this.row.connection
    }

    public get LastSeenLabel(): string
    {
        return this.row.lastSeenLabel
    }

    public get Banner(): HiveBannerState
    {
        return this.banner
    }

    public get HomeChannel(): readonly KeyValueItem[]
    {
        return this.homeChannel
    }

    public get EnvRows(): readonly ObservedEnvRow[]
    {
        return this.envRows
    }

    public get ObservationHistory(): readonly ObservationHistoryRow[]
    {
        return this.history
    }

    public get LedgerHistory(): readonly LedgerRow[]
    {
        return this.ledgerRows
    }

    private static Summarize(o: ObservationDto): string
    {
        const ready = o.environments.filter(e => e.ready).length
        return HiveDetailViewModel.SummaryTemplate
            .replace(HiveDetailViewModel.ReadyToken, String(ready))
            .replace(HiveDetailViewModel.TotalToken, String(o.environments.length))
    }

    private DeriveBanner(): HiveBannerState
    {
        if (this.row.connection === FleetConnection.Quiet)
        {
            return {
                show: true,
                tone: BannerTone.Warning,
                text: HiveDetailViewModel.QuietTemplate.replace(HiveDetailViewModel.NameToken, this.hive.displayName),
            }
        }
        if (this.row.connection === FleetConnection.Awaiting)
        {
            return { show: true, tone: BannerTone.Info, text: HiveDetailViewModel.AwaitingText }
        }
        return { show: false, tone: BannerTone.Info, text: HiveDetailViewModel.NoText }
    }
}
