import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { TenantPageViewModel } from '../../shell/tenant-page-view-model.js'
import type { TenantSessionService } from '../../shell/tenant-session-service.js'
import type { ConfigurationComponentDto, ConfigurationTargetDto } from '../../tenant-types.js'
import { ConfigurationText } from './configuration-rows.js'

// The Configuration section's moves: the list opens one component's page; that page goes back to the list.
export interface IConfigurationNavigator
{
    OpenComponent(component: string): void
    readonly BackCommand: RelayCommand
}

// One configurable component: its version head and what each of its targets has applied.
export class ConfigurationComponentRowViewModel extends Observable
{
    private static readonly NoVersions = 'No versions yet'
    private static readonly NoTargets = 'No targets'
    private static readonly TargetSeparator = '; '
    private static readonly EnvironmentSeparator = ': '
    private static readonly NothingApplied = 'nothing applied'
    private static readonly VersionWord = 'version '
    private static readonly AppliedSuffix = ' applied'

    private readonly openCommand: RelayCommand

    public constructor(private readonly dto: ConfigurationComponentDto, navigator: IConfigurationNavigator)
    {
        super()
        this.openCommand = new RelayCommand(() => navigator.OpenComponent(dto.component))
    }

    public get Component(): string
    {
        return this.dto.component
    }

    public get ComponentVersion(): string
    {
        return this.dto.componentVersion
    }

    public get HeadText(): string
    {
        return this.dto.head === null ? ConfigurationComponentRowViewModel.NoVersions : ConfigurationText.Version(this.dto.head)
    }

    // "production: version 2 applied; staging: nothing applied".
    public get TargetsText(): string
    {
        if (this.dto.targets.length === 0)
        {
            return ConfigurationComponentRowViewModel.NoTargets
        }
        return this.dto.targets.map(t => t.environment + ConfigurationComponentRowViewModel.EnvironmentSeparator
            + ConfigurationComponentRowViewModel.AppliedText(t)).join(ConfigurationComponentRowViewModel.TargetSeparator)
    }

    public get OpenCommand(): RelayCommand
    {
        return this.openCommand
    }

    private static AppliedText(target: ConfigurationTargetDto): string
    {
        return target.applied === null
            ? ConfigurationComponentRowViewModel.NothingApplied
            : ConfigurationComponentRowViewModel.VersionWord + String(target.applied) + ConfigurationComponentRowViewModel.AppliedSuffix
    }
}

// The Configuration section's root: the components this console holds configuration for. Reads are open to every
// session of the tenant; a component's page offers the edits to those holding the settings permission.
export class ConfigurationPageViewModel extends TenantPageViewModel
{
    private static readonly RowsProperty = 'Rows'

    private rows = new ObservableCollection<ConfigurationComponentRowViewModel>()

    public constructor(session: TenantSessionService, private readonly navigator: IConfigurationNavigator)
    {
        super(session)
    }

    public get Rows(): ObservableCollection<ConfigurationComponentRowViewModel>
    {
        return this.rows
    }

    protected override async LoadCore(): Promise<boolean>
    {
        const generation = this.LoadGeneration
        const components = await this.Session.Client.ListConfigurationComponents()
        if (generation !== this.LoadGeneration)
        {
            return components.length > 0
        }
        const old = this.rows
        this.rows = new ObservableCollection<ConfigurationComponentRowViewModel>()
        for (const component of components)
        {
            this.rows.Add(new ConfigurationComponentRowViewModel(component, this.navigator))
        }
        this.RaisePropertyChanged(ConfigurationPageViewModel.RowsProperty, old, this.rows)
        return components.length > 0
    }
}
