import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { FleetHiveDto } from './portal-types.js'
import { FleetConnection, FleetViewModel } from './fleet-view-model.js'
import type { FleetRow } from './fleet-view-model.js'
import type { ObservedEnvRow } from './observed-env-table.js'
import { BannerTone } from './kit/index.js'
import type { KeyValueItem } from './kit/index.js'

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
    private static readonly KeyConnection = 'Connection'
    private static readonly KeyLastCheckIn = 'Last check-in'
    private static readonly KeyCluster = 'Cluster'
    private static readonly KeyEnvironments = 'Environments observed'

    private readonly cluster: string
    private readonly row: FleetRow
    private readonly banner: HiveBannerState
    private readonly homeChannel: readonly KeyValueItem[]
    private readonly envRows: readonly ObservedEnvRow[]

    public constructor(
        private readonly hive: FleetHiveDto,
        now: () => Date = () => new Date(),
        quietThresholdMs?: number,
    )
    {
        super()
        this.row = new FleetViewModel([hive], now, quietThresholdMs).Rows[0]
        this.cluster = hive.clusterBackend + HiveDetailViewModel.ClusterSeparator + hive.clusterMode
        this.banner = this.DeriveBanner()
        this.homeChannel = [
            { key: HiveDetailViewModel.KeyConnection, value: this.row.lastSeenLabel },
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
