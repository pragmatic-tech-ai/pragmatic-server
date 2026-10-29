import { Orientation, StackPanel } from '@pragmatic-tech-ai/mural/basic'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import type { ControlPlaneClient } from './api-client.js'
import { DataTable, DeniedStatePanel, KeyValueGrid, PageHeader, ScreenHost, Section, TableDensity } from './kit/index.js'
import type { ScreenHostInputs, TableColumn } from './kit/index.js'
import type { OperatorContext } from './operator-context.js'
import type { IPortalNavigator, IPortalView } from './portal-types.js'
import { SettingsViewModel } from './settings-view-model.js'
import type { OperatorRow } from './settings-view-model.js'

// Settings: the signed-in operator's session and, for operators only, the operator roster. Read-only.
export class SettingsView extends StackPanel implements IPortalView
{
    private static readonly Breadcrumb: readonly string[] = ['Settings']
    private static readonly TitleText = 'Settings'
    private static readonly SessionTitle = 'Your session'
    private static readonly OperatorsTitle = 'Operators'
    private static readonly EmailLabel = 'Email'
    private static readonly RoleLabelText = 'Role'
    private static readonly OperatorKey = 'operator'
    private static readonly RoleKey = 'role'
    private static readonly OperatorHeader = 'Operator'
    private static readonly RoleHeader = 'Role'
    private static readonly SearchSeparator = ' '
    private static readonly OperatorsEmptyText = 'No operators are listed.'
    private static readonly DeniedWhat = 'the operator list'
    private static readonly EmptyTitle = 'Nothing to show.'
    private static readonly ErrorTitle = 'Could not load the operator list.'

    private readonly client: ControlPlaneClient
    private readonly operator: OperatorContext
    private readonly host: ScreenHost
    private readonly model: SettingsViewModel
    // Rebuilt fresh on every BuildContent: a Visual may hold only one parent.
    private sessionSlot = new StackPanel()
    private operatorsSlot = new StackPanel()
    private nav: IPortalNavigator | undefined

    public constructor(client: ControlPlaneClient, operator: OperatorContext, email: string)
    {
        super()
        this.client = client
        this.operator = operator
        this.model = new SettingsViewModel({ email, roleLabel: operator.RoleLabel })
        this.Orientation = Orientation.Vertical
        this.host = new ScreenHost(this.Inputs(true, false))
        this.AddChild(this.host)
    }

    // Test seam: the body host.
    public get Host(): ScreenHost
    {
        return this.host
    }

    // Test seam: the attached navigator.
    public get Navigator(): IPortalNavigator | undefined
    {
        return this.nav
    }

    // Test seam: the operators table (operator role, populated state only).
    public get Table(): DataTable<OperatorRow> | undefined
    {
        const child = [...this.operatorsSlot.Children][0]
        return child instanceof DataTable ? child as DataTable<OperatorRow> : undefined
    }

    public AttachNavigator(nav: IPortalNavigator): void
    {
        this.nav = nav
    }

    public async Refresh(): Promise<void>
    {
        // Only an operator may read the roster; an observer never triggers the fetch.
        if (this.operator.CanMutate)
        {
            this.host.Update(this.Inputs(true, false))
            try
            {
                this.model.Update(await this.client.ListOperators())
            }
            catch
            {
                this.ClearSlots()
                this.host.Update(this.Inputs(false, true))
                return
            }
        }
        this.host.Update(this.Inputs(false, false, () => this.BuildContent(this.model)))
    }

    private Inputs(loading: boolean, error: boolean, content?: () => Visual): ScreenHostInputs
    {
        return {
            loading,
            allowed: true,
            error,
            isEmpty: false,
            empty: { title: SettingsView.EmptyTitle },
            errorConfig: { title: SettingsView.ErrorTitle, onRetry: () => void this.Refresh() },
            content,
        }
    }

    private ClearSlots(): void
    {
        this.sessionSlot = new StackPanel()
        this.operatorsSlot = new StackPanel()
    }

    private BuildContent(model: SettingsViewModel): Visual
    {
        const root = new StackPanel()
        root.Orientation = Orientation.Vertical
        root.AddChild(new PageHeader({ breadcrumb: SettingsView.Breadcrumb, title: SettingsView.TitleText }))
        // Fresh slots per render: the previous ones are still parented to the previous Sections.
        this.ClearSlots()
        this.sessionSlot.Orientation = Orientation.Vertical
        this.sessionSlot.AddChild(new KeyValueGrid({
            items: [
                { key: SettingsView.EmailLabel, value: model.Email },
                { key: SettingsView.RoleLabelText, value: model.RoleLabel },
            ],
        }))
        this.operatorsSlot.Orientation = Orientation.Vertical
        if (this.operator.CanMutate)
        {
            this.operatorsSlot.AddChild(new DataTable<OperatorRow>({
                columns: SettingsView.Columns(),
                rows: model.Rows,
                density: TableDensity.Dense,
                searchText: r => r.email + SettingsView.SearchSeparator + r.roleLabel,
                emptyText: SettingsView.OperatorsEmptyText,
            }))
        }
        else
        {
            this.operatorsSlot.AddChild(new DeniedStatePanel({
                what: SettingsView.DeniedWhat,
                need: this.operator.NeededRoleLabel,
            }))
        }
        root.AddChild(new Section({ title: SettingsView.SessionTitle, body: this.sessionSlot }))
        root.AddChild(new Section({ title: SettingsView.OperatorsTitle, body: this.operatorsSlot }))
        return root
    }

    private static Columns(): TableColumn<OperatorRow>[]
    {
        return [
            {
                key: SettingsView.OperatorKey,
                header: SettingsView.OperatorHeader,
                cell: r => r.email,
                sort: (a, b) => a.email.localeCompare(b.email),
            },
            { key: SettingsView.RoleKey, header: SettingsView.RoleHeader, cell: r => r.roleLabel },
        ]
    }
}
