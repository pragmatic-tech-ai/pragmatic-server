import { Orientation, StackPanel, TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { HiveDetailViewModel } from './hive-detail-view-model.js'
import type { IHiveDetailSource, VersionRow } from './hive-detail-view-model.js'
import { TenantViewBase } from './tenant-view-base.js'
import { VersionBadge } from './tenant-types.js'
import type { HiveDto } from './tenant-types.js'

// Hive detail: header (name, running version, health dot), inline version list,
// confirm strip for a pending roll, and the failed-roll error line.
export class HiveDetailView extends TenantViewBase
{
    public static readonly EmptyText = 'No versions published yet'
    public static readonly SetTargetLabel = 'Set as target'
    public static readonly RollBackLabel = 'Roll back'
    public static readonly ConfirmLabel = 'Confirm'
    public static readonly CancelLabel = 'Cancel'
    public static readonly HealthyDot = '● healthy'
    public static readonly DegradedDot = '● degraded'
    public static readonly RunningPrefix = 'Running: '
    public static readonly NoRunningText = 'Running: none'
    public static readonly StayedOnPrefix = 'Stayed on '
    public static readonly FailedSeparator = ' - '
    public static readonly BadgeLabels: Readonly<Record<VersionBadge, string>> = {
        [VersionBadge.Current]: 'Current',
        [VersionBadge.Previous]: 'Previous',
        [VersionBadge.Available]: 'Available',
    }

    private static readonly PillSeparator = '  '

    private readonly vm: HiveDetailViewModel

    public constructor(source: IHiveDetailSource, private readonly hive: HiveDto)
    {
        super()
        this.vm = new HiveDetailViewModel(source, hive)
        this.vm.PropertyChanged(HiveDetailViewModel.PendingProperty).subscribe(() => this.Render())
        this.vm.PropertyChanged(HiveDetailViewModel.FailedRollProperty).subscribe(() => this.Render())
        this.Render()
    }

    public async Refresh(): Promise<void>
    {
        try
        {
            await this.vm.Load()
        }
        catch (e)
        {
            this.ShowError(e)
            return
        }
        this.Render()
    }

    public Render(): void
    {
        for (const child of [...this.Children])
        {
            this.RemoveChild(child)
        }
        this.AddChild(this.Text(this.hive.displayName))
        this.AddChild(this.Text(this.vm.RunningVersion === undefined ? HiveDetailView.NoRunningText : HiveDetailView.RunningPrefix + this.vm.RunningVersion))
        this.AddChild(this.Text(this.vm.Health.some(h => !h.ready) ? HiveDetailView.DegradedDot : HiveDetailView.HealthyDot))
        this.AddChild(this.message)
        const failed = this.vm.FailedRoll
        if (failed !== undefined)
        {
            this.AddChild(this.Text(failed.message + HiveDetailView.FailedSeparator + HiveDetailView.StayedOnPrefix + failed.stayedOn))
        }
        const pending = this.vm.Pending
        if (pending !== undefined)
        {
            const strip = new StackPanel()
            strip.Orientation = Orientation.Horizontal
            strip.AddChild(this.Text(pending.impact))
            strip.AddChild(this.MakeButton(HiveDetailView.ConfirmLabel, () => { void this.Run(() => this.vm.ConfirmTarget()) }))
            strip.AddChild(this.MakeButton(HiveDetailView.CancelLabel, () => this.vm.CancelTarget()))
            this.AddChild(strip)
        }
        if (this.vm.IsEmpty)
        {
            this.AddChild(this.Text(HiveDetailView.EmptyText))
            return
        }
        for (const row of this.vm.Versions)
        {
            this.AddChild(this.MakeRow(row))
        }
    }

    private MakeRow(row: VersionRow): StackPanel
    {
        const panel = new StackPanel()
        panel.Orientation = Orientation.Horizontal
        panel.AddChild(this.Text(row.manifest.id + HiveDetailView.PillSeparator + HiveDetailView.BadgeLabels[row.badge]))
        if (row.badge !== VersionBadge.Current)
        {
            const label = row.badge === VersionBadge.Previous ? HiveDetailView.RollBackLabel : HiveDetailView.SetTargetLabel
            panel.AddChild(this.MakeButton(label, () => this.vm.BeginTarget(row.manifest.id)))
        }
        return panel
    }

    private Text(text: string): TextBlock
    {
        const t = new TextBlock()
        t.Text = text
        return t
    }
}
