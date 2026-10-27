import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { DataGridRow } from '@pragmatic-tech-ai/mural/framework/data-grid/data-grid.js'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import { DataGridTemplateColumn, DataGridTextColumn } from '@pragmatic-tech-ai/mural/framework/data-grid/data-grid-column.js'
import type { PrivilegeRow } from '../src/privilege-row.js'
import { RolesPrivilegesView } from '../src/roles-privileges-view.js'
import { AccessLevel, Actions, PrivilegeAction } from '../src/security-model-draft.js'
import { TenantApiError } from '../src/tenant-api-client.js'
import type { EnvironmentDto, SecurityModelDto } from '../src/tenant-types.js'
import type { IRolesPrivilegesSource } from '../src/roles-privileges-view-model.js'

class Fixtures
{
    private static app: Application | undefined

    // Realizing grid rows needs the themed Application (as main.ts sets up).
    public static InitApp(): void
    {
        if (Fixtures.app === undefined)
        {
            Fixtures.app = new Application()
            Fixtures.app.initialize({ theme: Pragmatic, scheme: PragmaticLight })
        }
        Application.current = Fixtures.app
    }

    public static Texts(node: unknown): string[]
    {
        const n = node as { Text?: unknown; Children?: Iterable<unknown>; Content?: unknown }
        const out: string[] = []
        if (typeof n.Text === 'string')
        {
            out.push(n.Text)
        }
        if (n.Content !== undefined && n.Content !== null)
        {
            out.push(...Fixtures.Texts(n.Content))
        }
        if (n.Children !== undefined)
        {
            for (const c of n.Children)
            {
                out.push(...Fixtures.Texts(c))
            }
        }
        return out
    }

    public static Buttons(node: unknown, out: Button[] = []): Button[]
    {
        if (node instanceof Button)
        {
            out.push(node)
        }
        const n = node as { Children?: Iterable<unknown> }
        if (n.Children !== undefined)
        {
            for (const c of n.Children)
            {
                Fixtures.Buttons(c, out)
            }
        }
        return out
    }

    public static Labels(root: unknown): string[]
    {
        return Fixtures.Buttons(root).map(b => Fixtures.Texts(b).join(''))
    }

    public static ClickButton(b: Button): void
    {
        for (const h of (b as unknown as { _clickHandlers: Array<(a: unknown) => void> })._clickHandlers)
        {
            h({})
        }
    }

    public static Click(root: unknown, label: string): void
    {
        const b = Fixtures.Buttons(root).find(x => Fixtures.Texts(x).includes(label))
        assert.ok(b, 'button ' + label)
        Fixtures.ClickButton(b)
    }

    public static async Settle(): Promise<void>
    {
        await new Promise(r => setTimeout(r, 0))
    }

    public static HasPlaceholder(node: unknown, placeholder: string): boolean
    {
        const x = node as { Placeholder?: unknown; Children?: Iterable<unknown> }
        if (x.Placeholder === placeholder)
        {
            return true
        }
        for (const c of x.Children ?? [])
        {
            if (Fixtures.HasPlaceholder(c, placeholder))
            {
                return true
            }
        }
        return false
    }

    public static Collect(v: Visual, out: Visual[] = []): Visual[]
    {
        out.push(v)
        for (const c of v.visualChildren)
        {
            Fixtures.Collect(c, out)
        }
        return out
    }

    public static Rows(view: RolesPrivilegesView): DataGridRow[]
    {
        return view.Grid.logicalChildren.filter(c => c instanceof DataGridRow) as DataGridRow[]
    }

    // The realized cell Button for (concept, action column) found by walking the live grid.
    public static Cell(view: RolesPrivilegesView, concept: string, actionIndex: number): Button
    {
        const index = (view.Grid.ItemsSource as PrivilegeRow[]).findIndex(r => r.Concept === concept)
        const row = Fixtures.Rows(view)[index]
        const buttons = Fixtures.Collect(row).filter(v => v instanceof Button) as Button[]
        assert.equal(buttons.length, Actions.length)
        return buttons[actionIndex]
    }
}

class FakeSource implements IRolesPrivilegesSource
{
    public Envs: EnvironmentDto[] = [{ name: 'dev' } as EnvironmentDto]
    public GetError: Error | undefined
    public SetError: Error | undefined
    public Model: SecurityModelDto | null = {
        businessUnits: [],
        teams: [],
        membership: { claimsMapping: [], overrides: [] },
        ownershipRules: [{ concept: 'Order' } as never, { concept: 'Customer' } as never],
        roles: [
            { id: 'r1', name: 'Admin', privileges: [{ action: PrivilegeAction.Read, concept: 'Customer', level: AccessLevel.User }] },
            { id: 'r2', name: 'Viewer', privileges: [] }
        ]
    }

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        return this.Envs
    }

    public async GetSecurityModel(_env: string): Promise<SecurityModelDto | null>
    {
        if (this.GetError !== undefined)
        {
            throw this.GetError
        }
        return structuredClone(this.Model)
    }

    public async SetSecurityModel(_env: string, _model: SecurityModelDto): Promise<void>
    {
        if (this.SetError !== undefined)
        {
            throw this.SetError
        }
    }
}

class Harness
{
    public static async Make(src = new FakeSource()): Promise<RolesPrivilegesView>
    {
        Fixtures.InitApp()
        const view = new RolesPrivilegesView(src)
        await view.Refresh()
        return view
    }
}

describe('RolesPrivilegesView', () =>
{
    it('feeds one row per concept and builds a concept column plus eight template columns', async () =>
    {
        const view = await Harness.Make()
        const cols = [...view.Grid.Columns]
        assert.equal(cols.length, 9)
        assert.ok(cols[0] instanceof DataGridTextColumn)
        assert.equal((cols[0] as DataGridTextColumn).BindingPath, 'Concept')
        assert.ok(cols.slice(1).every(c => c instanceof DataGridTemplateColumn))
        assert.deepEqual(cols.slice(1).map(c => c.Header), [...RolesPrivilegesView.ActionLabels.values()])
        const rows = view.Grid.ItemsSource as PrivilegeRow[]
        assert.deepEqual(rows.map(r => r.Concept).sort(), ['Customer', 'Order'])
    })

    it('the realized grid has one DataGridRow per concept', async () =>
    {
        const view = await Harness.Make()
        assert.equal(Fixtures.Rows(view).length, 2)
    })

    it('a realized cell is a Button labelled with the level symbol; clicking advances it and flips Dirty', async () =>
    {
        const view = await Harness.Make()
        const cell = Fixtures.Cell(view, 'Customer', Actions.indexOf(PrivilegeAction.Read))
        assert.deepEqual(Fixtures.Texts(cell), [RolesPrivilegesView.UserSymbol])
        assert.equal(Fixtures.Texts(view).includes(RolesPrivilegesView.DirtyText), false)
        Fixtures.ClickButton(cell)
        assert.deepEqual(Fixtures.Texts(cell), [RolesPrivilegesView.BusinessUnitSymbol])
        assert.ok(Fixtures.Texts(view).includes(RolesPrivilegesView.DirtyText))
        assert.equal(Fixtures.Rows(view).length, 2)
    })

    it('mutating controls are no-ops while a save is in flight', async () =>
    {
        const src = new FakeSource()
        const view = await Harness.Make(src)
        let release: () => void = () => {}
        src.SetSecurityModel = (): Promise<void> => new Promise<void>(r => { release = r })
        Fixtures.ClickButton(Fixtures.Cell(view, 'Customer', 0))
        Fixtures.Click(view, RolesPrivilegesView.SaveLabel)
        await Fixtures.Settle()
        const roleCount = Fixtures.Labels(view).length
        const cell = Fixtures.Cell(view, 'Order', 0)
        Fixtures.ClickButton(cell)
        assert.deepEqual(Fixtures.Texts(cell), [RolesPrivilegesView.NoneSymbol])
        Fixtures.Click(view, 'Viewer')
        assert.ok(Fixtures.Labels(view).includes(RolesPrivilegesView.SelectedMark + 'Admin'))
        Fixtures.Click(view, RolesPrivilegesView.DeleteRoleLabel)
        assert.equal(Fixtures.Labels(view).length, roleCount)
        Fixtures.Click(view, RolesPrivilegesView.AddConceptLabel)
        assert.equal((view.Grid.ItemsSource as PrivilegeRow[]).length, 2)
        release()
        await Fixtures.Settle()
    })

    it('renders a role button per role with the selected one marked, and delete-role', async () =>
    {
        const view = await Harness.Make()
        const labels = Fixtures.Labels(view)
        assert.ok(labels.includes(RolesPrivilegesView.SelectedMark + 'Admin'))
        assert.ok(labels.includes('Viewer'))
        assert.ok(labels.includes(RolesPrivilegesView.DeleteRoleLabel))
        Fixtures.Click(view, 'Viewer')
        assert.ok(Fixtures.Labels(view).includes(RolesPrivilegesView.SelectedMark + 'Viewer'))
    })

    it('renders add-role and add-concept inputs and buttons', async () =>
    {
        const view = await Harness.Make()
        assert.ok(Fixtures.HasPlaceholder(view, RolesPrivilegesView.RolePlaceholder))
        assert.ok(Fixtures.HasPlaceholder(view, RolesPrivilegesView.ConceptPlaceholder))
        const labels = Fixtures.Labels(view)
        assert.ok(labels.includes(RolesPrivilegesView.AddRoleLabel))
        assert.ok(labels.includes(RolesPrivilegesView.AddConceptLabel))
    })

    it('renders the legend with all five symbols and names, plus Save and Revert', async () =>
    {
        const view = await Harness.Make()
        const texts = Fixtures.Texts(view)
        assert.ok(texts.includes(RolesPrivilegesView.LegendHeading))
        for (const level of RolesPrivilegesView.Symbols.keys())
        {
            const line = RolesPrivilegesView.Symbols.get(level)! + RolesPrivilegesView.LegendSeparator + RolesPrivilegesView.LevelNames.get(level)!
            assert.ok(texts.includes(line), line)
        }
        const labels = Fixtures.Labels(view)
        assert.ok(labels.includes(RolesPrivilegesView.SaveLabel))
        assert.ok(labels.includes(RolesPrivilegesView.RevertLabel))
    })

    it('renders Loading before the first refresh', () =>
    {
        const view = new RolesPrivilegesView(new FakeSource())
        assert.ok(Fixtures.Texts(view).includes(RolesPrivilegesView.LoadingText))
    })

    it('renders Empty, Error and PermissionDenied states distinctly', async () =>
    {
        const emptySrc = new FakeSource()
        emptySrc.Model = { ...emptySrc.Model!, roles: [] }
        const empty = Fixtures.Texts(await Harness.Make(emptySrc))
        assert.ok(empty.includes(RolesPrivilegesView.EmptyText))
        assert.equal(empty.includes(RolesPrivilegesView.PermissionDeniedText), false)

        const badSrc = new FakeSource()
        badSrc.GetError = new Error('boom')
        const bad = Fixtures.Texts(await Harness.Make(badSrc))
        assert.ok(bad.includes('boom'))
        assert.equal(bad.includes(RolesPrivilegesView.EmptyText), false)
        assert.equal(bad.includes(RolesPrivilegesView.PermissionDeniedText), false)

        const deniedSrc = new FakeSource()
        deniedSrc.GetError = new TenantApiError(403, 'forbidden')
        const denied = Fixtures.Texts(await Harness.Make(deniedSrc))
        assert.ok(denied.includes(RolesPrivilegesView.PermissionDeniedText))
        assert.equal(denied.includes(RolesPrivilegesView.EmptyText), false)
        assert.equal(denied.includes('forbidden'), false)
    })

    it('a 403 on Save renders the permission-denied text, not the raw error', async () =>
    {
        const src = new FakeSource()
        const view = await Harness.Make(src)
        src.SetError = new TenantApiError(403, 'forbidden')
        Fixtures.Click(view, RolesPrivilegesView.SaveLabel)
        await Fixtures.Settle()
        const texts = Fixtures.Texts(view)
        assert.ok(texts.includes(RolesPrivilegesView.PermissionDeniedText))
        assert.equal(texts.includes('forbidden'), false)
    })

    it('renders NoEnvironment when the tenant has no environments', async () =>
    {
        const src = new FakeSource()
        src.Envs = []
        assert.ok(Fixtures.Texts(await Harness.Make(src)).includes(RolesPrivilegesView.NoEnvironmentText))
    })

    it('Dispose does not throw', async () =>
    {
        const view = await Harness.Make()
        view.Dispose()
    })
})
