import { ObservableCollection } from '@pragmatic-tech-ai/mural/runtime'
import type { DialogService } from '@pragmatic-tech-ai/mural/framework/shell/services/dialog-service.js'
import type { ManifestDto } from '../../portal-types.js'
import { ReleaseChannel } from '../../release-channel.js'
import { OptionViewModel } from '../../shell/option-view-model.js'
import { PortalDialogViewModel } from '../../shell/portal-dialog-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'

// Publish a version: the version, its image, what's new (shown to tenants) and
// the channel it is offered on. The control plane signs and records it; hives
// see the offer on their next check-in, and tenants choose when to adopt.
export class PublishDialogViewModel extends PortalDialogViewModel<ManifestDto>
{
    private static readonly VersionProperty = 'Version'
    private static readonly ImageProperty = 'Image'
    private static readonly NotesProperty = 'Notes'
    private static readonly SelectedChannelProperty = 'SelectedChannel'

    private readonly channels = new ObservableCollection<OptionViewModel<string>>()
    private version = ''
    private image = ''
    private notes = ''
    private selectedChannel: OptionViewModel<string> | undefined

    public constructor(session: PortalSessionService, dialogs: DialogService)
    {
        super(session, dialogs)
        this.channels.Add(new OptionViewModel(ReleaseChannel.Stable, ReleaseChannel.Label(ReleaseChannel.Stable)))
        this.channels.Add(new OptionViewModel(ReleaseChannel.Early, ReleaseChannel.Label(ReleaseChannel.Early)))
        this.selectedChannel = this.channels.Get(0)
    }

    public get Version(): string
    {
        return this.version
    }

    public set Version(value: string)
    {
        this.SetField(PublishDialogViewModel.VersionProperty, this.version, value, v => { this.version = v })
    }

    public get Image(): string
    {
        return this.image
    }

    public set Image(value: string)
    {
        this.SetField(PublishDialogViewModel.ImageProperty, this.image, value, v => { this.image = v })
    }

    public get Notes(): string
    {
        return this.notes
    }

    public set Notes(value: string)
    {
        this.SetField(PublishDialogViewModel.NotesProperty, this.notes, value, v => { this.notes = v })
    }

    public get Channels(): ObservableCollection<OptionViewModel<string>>
    {
        return this.channels
    }

    public get SelectedChannel(): OptionViewModel<string> | undefined
    {
        return this.selectedChannel
    }

    public set SelectedChannel(value: OptionViewModel<string> | undefined)
    {
        this.SetField(PublishDialogViewModel.SelectedChannelProperty, this.selectedChannel, value, v => { this.selectedChannel = v })
    }

    protected override get CanConfirm(): boolean
    {
        return this.version.trim().length > 0 && this.image.trim().length > 0 && this.selectedChannel !== undefined
    }

    protected override async SubmitCore(): Promise<ManifestDto>
    {
        const notes = this.notes.trim()
        return await this.Session.Client.PublishManifest(this.version.trim(), this.image.trim(),
            notes.length > 0 ? notes : undefined, this.selectedChannel?.Value ?? ReleaseChannel.Stable)
    }
}
