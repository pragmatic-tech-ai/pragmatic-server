import { Orientation, StackPanel, TextBlock, TextBox } from '@pragmatic-tech-ai/mural/basic'
import { ComboBox } from '@pragmatic-tech-ai/mural/framework'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import type { ControlPlaneClient } from './api-client.js'
import { ReleaseChannel } from './release-channel.js'
import { ReleaseDetailView } from './release-detail-view.js'
import { ReleaseDetailViewModel } from './release-detail-view-model.js'
import { ReleasesViewModel } from './releases-view-model.js'
import type { ReleaseListRow } from './releases-view-model.js'
import { SectionContainerView, SectionState } from './section-container-view.js'
import type { SectionLabels } from './section-container-view.js'
import { CreateManifestViewModel } from './create-manifest-view-model.js'
import { OperatorContext } from './operator-context.js'
import { Act, ActVariant, ComboOption, KeyActivatedButton, PageHeader, PillKind, PillKinds, Section } from './kit/index.js'
import type { PillEntry, TableColumn } from './kit/index.js'

export enum ReleasesMode
{
    List,
    Detail,
    Publish,
}

// Registry section: a self-routing container (list / detail). Full operators can publish a new version.
export class ReleasesView extends SectionContainerView<ReleaseListRow>
{
    private static readonly ListBreadcrumb: readonly string[] = ['Releases', 'Registry & Releases']
    private static readonly ChannelLabelPath = 'Label'
    private static readonly ChannelStableLabel = 'Stable'
    private static readonly ChannelEarlyLabel = 'Early access'
    private static readonly ListTitle = 'Registry & Releases'
    private static readonly PublishBreadcrumb: readonly string[] = ['Registry & Releases', 'Publish version']
    private static readonly PublishTitle = 'Publish version'
    private static readonly PublishActionLabel = 'Publish version'
    private static readonly SubmitLabel = 'Publish'
    private static readonly CancelLabel = 'Cancel'
    private static readonly VersionPlaceholder = 'Version'
    private static readonly ImagePlaceholder = 'Image'
    private static readonly NotesPlaceholder = 'Notes (optional)'
    private static readonly FormTitle = 'Version details'
    private static readonly BlankText = ''
    private static readonly RequiredText = 'Version and image are required.'
    private static readonly EmptyTitle = 'No versions published yet.'
    private static readonly ErrorTitle = 'Could not load the releases.'
    private static readonly TableEmptyText = 'No versions match.'
    private static readonly SearchSeparator = ' '
    private static readonly EnvSuffix = ' environment(s)'
    private static readonly NotObserved = 'Not observed running'
    private static readonly VersionKey = 'version'
    private static readonly StatusKey = 'status'
    private static readonly ImageKey = 'image'
    private static readonly PublishedKey = 'published'
    private static readonly RunningKey = 'running'
    private static readonly VersionHeader = 'Version'
    private static readonly StatusHeader = 'Status'
    private static readonly ImageHeader = 'Image'
    private static readonly PublishedHeader = 'Published'
    private static readonly RunningHeader = 'Running'

    private model: ReleasesViewModel | undefined = undefined
    private publishAction: Act | undefined
    private submitAction: Act | undefined
    private errorText: TextBlock | undefined
    private readonly createModel: CreateManifestViewModel

    public constructor(private readonly client: ControlPlaneClient, private readonly operator: OperatorContext)
    {
        super()
        this.createModel = new CreateManifestViewModel(client)
    }

    public get Mode(): ReleasesMode
    {
        return this.State === SectionState.Custom
            ? ReleasesMode.Publish
            : this.State === SectionState.Detail ? ReleasesMode.Detail : ReleasesMode.List
    }

    // Test seam: the list's publish action.
    public get PublishAction(): Act | undefined
    {
        return this.publishAction
    }

    // Test seam: the publish form's submit action.
    public get SubmitAction(): Act | undefined
    {
        return this.submitAction
    }

    // Test seam: the publish form's current error line.
    public get ErrorLine(): string
    {
        return this.errorText?.Text ?? ReleasesView.BlankText
    }

    public ShowPublish(): void
    {
        this.EnterCustom()
        this.SwapScreen(this.BuildPublish())
    }

    // Called on every render and an Act holds one parent, so build a fresh Act each time.
    protected ListPrimaryAction(): Act | undefined
    {
        this.publishAction = new Act(this.operator.MutatingAct(ReleasesView.PublishActionLabel, () => this.ShowPublish()))
        return this.publishAction
    }

    private BuildPublish(): Visual
    {
        const root = new StackPanel()
        root.Orientation = Orientation.Vertical
        root.AddChild(new PageHeader({ breadcrumb: ReleasesView.PublishBreadcrumb, title: ReleasesView.PublishTitle }))
        const versionBox = ReleasesView.Box(ReleasesView.VersionPlaceholder)
        const imageBox = ReleasesView.Box(ReleasesView.ImagePlaceholder)
        const notesBox = ReleasesView.Box(ReleasesView.NotesPlaceholder)
        const channelBox = ReleasesView.ChannelBox()
        const errorText = new TextBlock()
        this.errorText = errorText
        const submit = new Act(this.operator.MutatingAct(
            ReleasesView.SubmitLabel,
            () => void this.Submit(versionBox.Text, imageBox.Text, notesBox.Text, ReleasesView.ChannelOf(channelBox)),
            ActVariant.Primary,
        ))
        this.submitAction = submit
        const cancel = new KeyActivatedButton(() => void this.ShowList())
        const cancelText = new TextBlock()
        cancelText.Text = ReleasesView.CancelLabel
        cancel.Content = cancelText
        const body = new StackPanel()
        body.Orientation = Orientation.Vertical
        body.AddChild(versionBox)
        body.AddChild(imageBox)
        body.AddChild(notesBox)
        body.AddChild(channelBox)
        body.AddChild(errorText)
        body.AddChild(submit)
        body.AddChild(cancel)
        root.AddChild(new Section({ title: ReleasesView.FormTitle, body }))
        return root
    }

    private static ChannelBox(): ComboBox
    {
        const box = new ComboBox()
        box.DisplayMemberPath = ReleasesView.ChannelLabelPath
        box.ItemsSource = [
            new ComboOption(ReleasesView.ChannelStableLabel, ReleaseChannel.Stable),
            new ComboOption(ReleasesView.ChannelEarlyLabel, ReleaseChannel.Early),
        ]
        box.SelectedIndex = 0
        return box
    }

    private static ChannelOf(box: ComboBox): string
    {
        return (box.SelectedItem as ComboOption | undefined)?.Value ?? ReleaseChannel.Stable
    }

    private static Box(placeholder: string): TextBox
    {
        const box = new TextBox()
        box.Placeholder = placeholder
        return box
    }

    private async Submit(version: string, image: string, notes: string, channel: string): Promise<void>
    {
        if (this.errorText !== undefined)
        {
            this.errorText.Text = ReleasesView.BlankText
        }
        if (!this.createModel.CanSubmit(version, image))
        {
            if (this.errorText !== undefined)
            {
                this.errorText.Text = ReleasesView.RequiredText
            }
            return
        }
        try
        {
            await this.createModel.Submit(version, image, notes, channel)
        }
        catch (e)
        {
            if (this.errorText !== undefined)
            {
                this.errorText.Text = e instanceof Error ? e.message : String(e)
            }
            return
        }
        await this.ShowList()
    }

    protected Labels(): SectionLabels
    {
        return {
            listBreadcrumb: ReleasesView.ListBreadcrumb,
            listTitle: ReleasesView.ListTitle,
            emptyTitle: ReleasesView.EmptyTitle,
            errorTitle: ReleasesView.ErrorTitle,
            tableEmptyText: ReleasesView.TableEmptyText,
        }
    }

    protected SearchText(row: ReleaseListRow): string
    {
        return row.id + ReleasesView.SearchSeparator + row.image
    }

    protected async LoadRows(): Promise<readonly ReleaseListRow[]>
    {
        const [manifests, fleet] = await Promise.all([this.client.ListManifests(), this.client.ListFleet()])
        if (this.model === undefined)
        {
            this.model = new ReleasesViewModel(manifests, fleet)
        }
        else
        {
            this.model.Update(manifests, fleet)
        }
        return this.model.Rows
    }

    protected async BuildDetail(row: ReleaseListRow): Promise<Visual | undefined>
    {
        const [manifests, fleet] = await Promise.all([this.client.ListManifests(), this.client.ListFleet()])
        const manifest = manifests.find(m => m.id === row.id)
        if (manifest === undefined)
        {
            return undefined
        }
        return new ReleaseDetailView(
            new ReleaseDetailViewModel(manifest, fleet),
            () => void this.ShowList(),
            this.operator,
            async (withdraw: boolean, reason?: string) =>
            {
                await this.client.SetManifestWithdrawn(row.id, withdraw, reason)
                await this.ShowDetail(row)
            },
        )
    }

    private static StatusPill(r: ReleaseListRow): PillEntry
    {
        return PillKinds.For(r.withdrawn ? PillKind.Withdrawn : PillKind.Published)
    }

    protected Columns(): TableColumn<ReleaseListRow>[]
    {
        return [
            {
                key: ReleasesView.VersionKey,
                header: ReleasesView.VersionHeader,
                cell: r => r.id,
                sort: (a, b) => a.id.localeCompare(b.id),
            },
            {
                key: ReleasesView.StatusKey,
                header: ReleasesView.StatusHeader,
                cell: r => ReleasesView.StatusPill(r).label,
                tone: r => r.withdrawn ? ReleasesView.StatusPill(r).tone : undefined,
            },
            { key: ReleasesView.ImageKey, header: ReleasesView.ImageHeader, cell: r => r.image },
            { key: ReleasesView.PublishedKey, header: ReleasesView.PublishedHeader, cell: r => r.publishedLabel },
            {
                key: ReleasesView.RunningKey,
                header: ReleasesView.RunningHeader,
                cell: r => r.observedEnvCount > 0 ? r.observedEnvCount + ReleasesView.EnvSuffix : ReleasesView.NotObserved,
                sort: (a, b) => a.observedEnvCount - b.observedEnvCount,
            },
        ]
    }
}
