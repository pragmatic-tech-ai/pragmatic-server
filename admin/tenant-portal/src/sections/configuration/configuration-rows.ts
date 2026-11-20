import { RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { UtcText } from '../../shell/utc-text.js'
import { ConfigurationApplyOutcome, ConfigurationChangeKind } from '../../tenant-types.js'
import type { ConfigurationApplyDto, ConfigurationChangeDto, ConfigurationOptionDto, ConfigurationSettingDto, ConfigurationTargetDto, ConfigurationValidationErrorDto, ConfigurationVersionSummaryDto } from '../../tenant-types.js'

// How the configuration pages write versions and values.
export class ConfigurationText
{
    public static readonly EmptyDocumentLabel = 'Empty document'

    private static readonly VersionPrefix = 'Version '
    private static readonly NoText = ''
    private static readonly JsonIndent = 2

    public static Version(version: number): string
    {
        return ConfigurationText.VersionPrefix + String(version)
    }

    // A setting's value as JSON (a string keeps its quotes, so "10" and 10 read apart); '' when absent.
    public static Value(value: unknown): string
    {
        return value === undefined ? ConfigurationText.NoText : JSON.stringify(value)
    }

    // A whole document, indented for reading and editing.
    public static Document(document: unknown): string
    {
        return JSON.stringify(document, null, ConfigurationText.JsonIndent)
    }
}

// One setting a component's descriptor declares, under its option. A secret setting takes a secret reference
// (secret:<store>/<name>), never a value, so its type reads as such.
export class ConfigurationSettingRowViewModel extends Observable
{
    private static readonly PathSeparator = '.'
    private static readonly SecretType = 'secret reference'
    private static readonly RequiredLabel = 'Required'
    private static readonly OptionalLabel = 'Optional'
    private static readonly DefaultPrefix = 'Default '
    private static readonly NoDefault = ''

    public constructor(private readonly option: ConfigurationOptionDto, private readonly setting: ConfigurationSettingDto)
    {
        super()
    }

    public get Path(): string
    {
        return this.option.name + ConfigurationSettingRowViewModel.PathSeparator + this.setting.name
    }

    public get TypeText(): string
    {
        return this.setting.secret ? ConfigurationSettingRowViewModel.SecretType : this.setting.type
    }

    public get IsSecret(): boolean
    {
        return this.setting.secret
    }

    public get RequiredText(): string
    {
        return this.setting.required ? ConfigurationSettingRowViewModel.RequiredLabel : ConfigurationSettingRowViewModel.OptionalLabel
    }

    public get DefaultText(): string
    {
        return this.setting.default === undefined
            ? ConfigurationSettingRowViewModel.NoDefault
            : ConfigurationSettingRowViewModel.DefaultPrefix + ConfigurationText.Value(this.setting.default)
    }

    public get Description(): string
    {
        return this.setting.description
    }
}

// One saved version; View shows its document.
export class ConfigurationVersionRowViewModel extends Observable
{
    public constructor(private readonly summary: ConfigurationVersionSummaryDto, public readonly IsHead: boolean, public readonly ViewCommand: RelayCommand)
    {
        super()
    }

    public get Version(): number
    {
        return this.summary.version
    }

    public get VersionText(): string
    {
        return ConfigurationText.Version(this.summary.version)
    }

    public get Author(): string
    {
        return this.summary.author
    }

    public get CreatedText(): string
    {
        return UtcText.DateTime(this.summary.createdAt)
    }

    public get Comment(): string
    {
        return this.summary.comment
    }
}

// Where the component runs, and which version is applied there.
export class ConfigurationTargetRowViewModel extends Observable
{
    private static readonly NothingApplied = 'Nothing applied'
    private static readonly AppliedSuffix = ' applied'

    public constructor(private readonly target: ConfigurationTargetDto)
    {
        super()
    }

    public get Environment(): string
    {
        return this.target.environment
    }

    public get Hive(): string
    {
        return this.target.hive
    }

    public get Namespace(): string
    {
        return this.target.namespace
    }

    public get Deployment(): string
    {
        return this.target.deployment
    }

    public get AppliedText(): string
    {
        return this.target.applied === null
            ? ConfigurationTargetRowViewModel.NothingApplied
            : ConfigurationText.Version(this.target.applied) + ConfigurationTargetRowViewModel.AppliedSuffix
    }
}

// One apply of a version to an environment, as recorded.
export class ConfigurationApplyRowViewModel extends Observable
{
    private static readonly AppliedLabel = 'Applied'
    private static readonly FailedLabel = 'Failed'
    private static readonly NoDetail = ''

    public constructor(private readonly apply: ConfigurationApplyDto)
    {
        super()
    }

    public get VersionText(): string
    {
        return ConfigurationText.Version(this.apply.version)
    }

    public get Environment(): string
    {
        return this.apply.environment
    }

    public get OutcomeText(): string
    {
        return this.apply.outcome === ConfigurationApplyOutcome.Applied ? ConfigurationApplyRowViewModel.AppliedLabel : ConfigurationApplyRowViewModel.FailedLabel
    }

    public get IsFailed(): boolean
    {
        return this.apply.outcome !== ConfigurationApplyOutcome.Applied
    }

    public get RequestedBy(): string
    {
        return this.apply.requestedBy
    }

    public get RequestedText(): string
    {
        return UtcText.DateTime(this.apply.requestedAt)
    }

    public get DetailText(): string
    {
        return this.apply.detail ?? ConfigurationApplyRowViewModel.NoDetail
    }
}

// One difference between two versions, at a setting's path.
export class ConfigurationChangeRowViewModel extends Observable
{
    private static readonly AddedLabel = 'Added'
    private static readonly RemovedLabel = 'Removed'
    private static readonly ChangedLabel = 'Changed'

    public constructor(private readonly change: ConfigurationChangeDto)
    {
        super()
    }

    public get Path(): string
    {
        return this.change.path
    }

    public get KindText(): string
    {
        switch (this.change.kind)
        {
            case ConfigurationChangeKind.Added:
                return ConfigurationChangeRowViewModel.AddedLabel
            case ConfigurationChangeKind.Removed:
                return ConfigurationChangeRowViewModel.RemovedLabel
            case ConfigurationChangeKind.Changed:
                return ConfigurationChangeRowViewModel.ChangedLabel
        }
    }

    public get BeforeText(): string
    {
        return ConfigurationText.Value(this.change.before)
    }

    public get AfterText(): string
    {
        return ConfigurationText.Value(this.change.after)
    }
}

// One reason the server refused a saved document, at its path.
export class ConfigurationErrorRowViewModel extends Observable
{
    public constructor(private readonly error: ConfigurationValidationErrorDto)
    {
        super()
    }

    public get Path(): string
    {
        return this.error.path
    }

    public get Message(): string
    {
        return this.error.message
    }
}
