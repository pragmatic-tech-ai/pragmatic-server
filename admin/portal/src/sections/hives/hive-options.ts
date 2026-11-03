import type { HiveClusterBackend, HiveProvisionMode } from '../../portal-types.js'
import { OptionViewModel } from '../../shell/option-view-model.js'

// The ComboBox choices a hive's cluster and registry offer, shared by Create
// hive and Stand up a hive. The first choice of each list is the default.
export class HiveOptions
{
    private static readonly AksBackend: HiveClusterBackend = 'aks'
    private static readonly EksBackend: HiveClusterBackend = 'eks'
    private static readonly GkeBackend: HiveClusterBackend = 'gke'
    private static readonly PrivateBackend: HiveClusterBackend = 'private'
    private static readonly LocalBackend: HiveClusterBackend = 'local'
    private static readonly ProvisionMode: HiveProvisionMode = 'provision'
    private static readonly AttachMode: HiveProvisionMode = 'attach'
    private static readonly AksLabel = 'AKS (Azure)'
    private static readonly EksLabel = 'EKS (AWS)'
    private static readonly GkeLabel = 'GKE (Google Cloud)'
    private static readonly PrivateLabel = 'Private cluster'
    private static readonly LocalLabel = 'Local'
    private static readonly ProvisionLabel = 'Provision'
    private static readonly AttachLabel = 'Attach existing'
    // A hive id becomes Kubernetes names and the pragmatic/hive label value (the control plane enforces the same rule).
    private static readonly IdPattern = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
    private static readonly IdMaxLength = 63
    private static readonly IdRuleText = "Use a lowercase name: letters a-z, digits and '-', starting and ending with a letter or digit, at most 63 characters."
    private static readonly NoText = ''

    // Whether a (trimmed) hive id is a valid lowercase Kubernetes name.
    public static IsValidId(id: string): boolean
    {
        return id.length <= HiveOptions.IdMaxLength && HiveOptions.IdPattern.test(id)
    }

    // Why a typed hive id is refused; '' while it is empty or valid.
    public static IdHintFor(id: string): string
    {
        const trimmed = id.trim()
        return trimmed.length === 0 || HiveOptions.IsValidId(trimmed) ? HiveOptions.NoText : HiveOptions.IdRuleText
    }

    // The cluster backends, Local first.
    public static Backends(): OptionViewModel<HiveClusterBackend>[]
    {
        const C = HiveOptions
        return [
            new OptionViewModel(C.LocalBackend, C.LocalLabel),
            new OptionViewModel(C.AksBackend, C.AksLabel),
            new OptionViewModel(C.EksBackend, C.EksLabel),
            new OptionViewModel(C.GkeBackend, C.GkeLabel),
            new OptionViewModel(C.PrivateBackend, C.PrivateLabel),
        ]
    }

    // The cluster or registry modes, Attach existing first.
    public static Modes(): OptionViewModel<HiveProvisionMode>[]
    {
        const C = HiveOptions
        return [
            new OptionViewModel(C.AttachMode, C.AttachLabel),
            new OptionViewModel(C.ProvisionMode, C.ProvisionLabel),
        ]
    }
}
