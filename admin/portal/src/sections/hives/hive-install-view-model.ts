import { RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import type { ClipboardService } from '@pragmatic-tech-ai/mural/framework/shell/services/clipboard-service.js'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import type { HiveBootstrapDto } from '../../portal-types.js'
import type { DownloadService } from '../../shell/download-service.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'

// What the install commands do: a first install applies the bundle and
// creates the token Secret; a rotation replaces the Secret and restarts the
// hive's deployments that read it (the agent and, when installed, the
// tenant-admin pod), since a Secret-sourced env only changes on restart.
export enum HiveInstallMode
{
    FirstInstall,
    Rotate,
}

// Where the install panel copies and downloads to: its section.
export interface IHiveInstallHost
{
    readonly Clipboard: ClipboardService | undefined
    readonly Downloads: DownloadService | undefined
}

// The "install the agent" panel: the hive's secret-free bundle to download
// and the kubectl commands that apply it. The commands never contain the
// agent token: the administrator types it at a silent `read` prompt, so it
// stays out of shell history and the process list (and out of anything this
// panel copies). A failed bundle read only shows here, never reloads the
// page: a reload would discard a one-time token still on screen.
export class HiveInstallViewModel extends Observable
{
    private static readonly TokenVariable = 'PRAGMATIC_AGENT_TOKEN'
    private static readonly LineBreak = '\n'
    private static readonly NoText = ''
    private static readonly CopiedText = 'Copied.'
    private static readonly CopyFailedText = 'Could not copy. Select the commands and copy them by hand.'
    private static readonly DownloadFailedText = 'Could not start the download.'
    private static readonly ApplyPrefix = 'kubectl apply -f '
    private static readonly ReadPrefix = 'read -rs '
    private static readonly ReadComment = '   # paste the one-time agent token, then press Enter'
    private static readonly KubectlNamespacePrefix = 'kubectl -n '
    private static readonly CreateSecretInfix = ' create secret generic '
    private static readonly FromLiteralInfix = ' --from-literal='
    private static readonly ValueOpen = '="$'
    private static readonly ValueClose = '"'
    private static readonly ReplaceSuffix = ' --dry-run=client -o yaml | kubectl apply -f -'
    private static readonly RestartInfix = ' rollout restart deployment -l '
    private static readonly IsLoadingProperty = 'IsLoading'
    private static readonly HasBundleProperty = 'HasBundle'
    private static readonly ErrorTextProperty = 'ErrorText'
    private static readonly CommandsProperty = 'Commands'
    private static readonly FileNameProperty = 'FileName'
    private static readonly ChannelUrlProperty = 'ChannelUrl'
    private static readonly StatusProperty = 'Status'

    private bundle: HiveBootstrapDto | undefined
    private loading = false
    private errorText = HiveInstallViewModel.NoText
    private status = HiveInstallViewModel.NoText
    private loadGeneration = 0
    private readonly downloadCommand: RelayCommand
    private readonly copyCommandsCommand: RelayCommand

    public constructor(private readonly session: PortalSessionService, private readonly host: IHiveInstallHost, private readonly mode: HiveInstallMode)
    {
        super()
        this.downloadCommand = new RelayCommand(() => this.Download(), () => this.bundle !== undefined)
        this.copyCommandsCommand = new RelayCommand(() => { void this.CopyCommands() }, () => this.bundle !== undefined)
    }

    public get IsLoading(): boolean
    {
        return this.loading
    }

    public get HasBundle(): boolean
    {
        return this.bundle !== undefined
    }

    // Why the bundle is unavailable (e.g. the agent channel is off); '' otherwise.
    public get ErrorText(): string
    {
        return this.errorText
    }

    public get FileName(): string
    {
        return this.bundle?.fileName ?? HiveInstallViewModel.NoText
    }

    // The URL the agent dials home on.
    public get ChannelUrl(): string
    {
        return this.bundle?.channelUrl ?? HiveInstallViewModel.NoText
    }

    // The commands to run in the client's cluster, one per line.
    public get Commands(): string
    {
        const b = this.bundle
        if (b === undefined)
        {
            return HiveInstallViewModel.NoText
        }
        const C = HiveInstallViewModel
        const readToken = C.ReadPrefix + C.TokenVariable + C.ReadComment
        const createSecret = C.KubectlNamespacePrefix + b.namespace + C.CreateSecretInfix + b.tokenSecretName
            + C.FromLiteralInfix + b.tokenSecretKey + C.ValueOpen + C.TokenVariable + C.ValueClose
        const lines = this.mode === HiveInstallMode.FirstInstall
            ? [C.ApplyPrefix + b.fileName, readToken, createSecret]
            : [readToken, createSecret + C.ReplaceSuffix, C.KubectlNamespacePrefix + b.namespace + C.RestartInfix + b.hiveSelector]
        return lines.join(C.LineBreak)
    }

    // The outcome of the last Copy or Download; '' until one.
    public get Status(): string
    {
        return this.status
    }

    public get DownloadCommand(): RelayCommand
    {
        return this.downloadCommand
    }

    public get CopyCommandsCommand(): RelayCommand
    {
        return this.copyCommandsCommand
    }

    // Loads the hive's bundle; any refusal shows in ErrorText. When loads
    // overlap, only the latest one applies. Never throws.
    public async Load(hiveId: string): Promise<void>
    {
        const generation = ++this.loadGeneration
        const before = this.Snapshot()
        this.loading = true
        this.RaiseChangedSince(before)
        let bundle: HiveBootstrapDto | undefined
        let error = HiveInstallViewModel.NoText
        try
        {
            bundle = await this.session.Client.GetHiveBootstrap(hiveId)
        }
        catch (e)
        {
            error = e instanceof Error ? e.message : String(e)
        }
        if (generation !== this.loadGeneration)
        {
            return
        }
        const loaded = this.Snapshot()
        this.bundle = bundle
        this.errorText = error
        this.loading = false
        this.RaiseChangedSince(loaded)
    }

    private Download(): void
    {
        const b = this.bundle
        const downloads = this.host.Downloads
        if (b === undefined)
        {
            return
        }
        if (downloads === undefined)
        {
            this.SetStatus(HiveInstallViewModel.DownloadFailedText)
            return
        }
        downloads.Save(b.fileName, b.manifest)
    }

    private async CopyCommands(): Promise<void>
    {
        const clipboard = this.host.Clipboard
        if (clipboard === undefined)
        {
            this.SetStatus(HiveInstallViewModel.CopyFailedText)
            return
        }
        try
        {
            await clipboard.WriteText(this.Commands)
            this.SetStatus(HiveInstallViewModel.CopiedText)
        }
        catch
        {
            this.SetStatus(HiveInstallViewModel.CopyFailedText)
        }
    }

    private SetStatus(next: string): void
    {
        const old = this.status
        if (old === next)
        {
            return
        }
        this.status = next
        this.RaisePropertyChanged(HiveInstallViewModel.StatusProperty, old, next)
    }

    private Snapshot(): HiveInstallSnapshot
    {
        return {
            IsLoading: this.IsLoading,
            HasBundle: this.HasBundle,
            ErrorText: this.ErrorText,
            Commands: this.Commands,
            FileName: this.FileName,
            ChannelUrl: this.ChannelUrl,
        }
    }

    private RaiseChangedSince(b: HiveInstallSnapshot): void
    {
        const C = HiveInstallViewModel
        this.RaiseIfChanged(C.IsLoadingProperty, b.IsLoading, this.IsLoading)
        this.RaiseIfChanged(C.HasBundleProperty, b.HasBundle, this.HasBundle)
        this.RaiseIfChanged(C.ErrorTextProperty, b.ErrorText, this.ErrorText)
        this.RaiseIfChanged(C.CommandsProperty, b.Commands, this.Commands)
        this.RaiseIfChanged(C.FileNameProperty, b.FileName, this.FileName)
        this.RaiseIfChanged(C.ChannelUrlProperty, b.ChannelUrl, this.ChannelUrl)
        if (b.HasBundle !== this.HasBundle)
        {
            this.downloadCommand.RaiseCanExecuteChanged()
            this.copyCommandsCommand.RaiseCanExecuteChanged()
        }
    }

    private RaiseIfChanged<T>(name: string, old: T, now: T): void
    {
        if (old !== now)
        {
            this.RaisePropertyChanged(name, old, now)
        }
    }
}

// The install panel's bound values before a change, for its notifications.
interface HiveInstallSnapshot
{
    readonly IsLoading: boolean
    readonly HasBundle: boolean
    readonly ErrorText: string
    readonly Commands: string
    readonly FileName: string
    readonly ChannelUrl: string
}
