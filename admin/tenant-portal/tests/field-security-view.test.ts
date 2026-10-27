import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { Checkbox } from '@pragmatic-tech-ai/mural/framework/toggles/checkbox.js'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { DataGridRow } from '@pragmatic-tech-ai/mural/framework/data-grid/data-grid.js'
import type { Visual } from '@pragmatic-tech-ai/mural/runtime'
import { DataGridTemplateColumn, DataGridTextColumn } from '@pragmatic-tech-ai/mural/framework/data-grid/data-grid-column.js'
import type { FieldGrantRow } from '../src/field-grant-row.js'
import { FieldSecurityView } from '../src/field-security-view.js'
import { FieldPermission, FieldPermissions } from '../src/security-model-draft.js'
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

    // Mimics a pointer click: Button.fireClick runs OnPreClick (the toggle flip) then the handlers.
    public static ClickButton(b: Button): void
    {
        (b as unknown as { fireClick(a: unknown): void }).fireClick({})
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

    public static Box(node: unknown, placeholder: string): { Text: string } | undefined
    {
        const x = node as { Placeholder?: unknown; Children?: Iterable<unknown> }
        if (x.Placeholder === placeholder)
        {
            return x as unknown as { Text: string }
        }
        for (const c of x.Children ?? [])
        {
            const found = Fixtures.Box(c, placeholder)
            if (found !== undefined)
            {
                return found
            }
        }
        return undefined
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

    public static Rows(view: FieldSecurityView): DataGridRow[]
    {
        return view.Grid.logicalChildren.filter(c => c instanceof DataGridRow) as DataGridRow[]
    }

    // The realized cell Checkbox for (field label, permission column) found by walking the live grid.
    public static Cell(view: FieldSecurityView, label: string, permission: FieldPermission): Checkbox
    {
        const index = (view.Grid.ItemsSource as FieldGrantRow[]).findIndex(r => r.Label === label)
        const row = Fixtures.Rows(view)[index]
        const boxes = Fixtures.Collect(row).filter(v => v instanceof Checkbox) as Checkbox[]
        assert.equal(boxes.length, FieldPermissions.length)
        return boxes[FieldPermissions.indexOf(permission)]
    }
}

class FakeSource implements IRolesPrivilegesSource
{
    public Envs: EnvironmentDto[] = [{ name: 'dev' } as EnvironmentDto]
    public GetError: Error | undefined
    public SetError: Error | undefined
    public Saved: SecurityModelDto | undefined
    public Model: SecurityModelDto | null = {
        businessUnits: [],
        teams: [],
        membership: { claimsMapping: [], overrides: [] },
        ownershipRules: [],
        roles: [],
        fieldSecurity: {
            securedFields: [{ concept: 'Customer', field: 'ssn' }, { concept: 'Order', field: 'total' }],
            profiles: [
                { id: 'p1', name: 'Full', grants: [{ concept: 'Customer', field: 'ssn', read: true }] },
                { id: 'p2', name: 'Limited', grants: [] }
            ],
            profileAssignment: { claimsMapping: [], overrides: [], teamProfiles: [] }
        }
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

    public async SetSecurityModel(_env: string, model: SecurityModelDto): Promise<void>
    {
        if (this.SetError !== undefined)
        {
            throw this.SetError
        }
        this.Saved = model
    }
}

class Harness
{
    public static readonly SsnLabel = 'Customer · ssn'
    public static readonly TotalLabel = 'Order · total'

    public static async Make(src = new FakeSource()): Promise<FieldSecurityView>
    {
        Fixtures.InitApp()
        const view = new FieldSecurityView(src)
        await view.Refresh()
        return view
    }
}

describe('FieldSecurityView', () =>
{
    it('feeds one row per secured field and builds a Field column plus three template columns', async () =>
    {
        const view = await Harness.Make()
        const cols = [...view.Grid.Columns]
        assert.equal(cols.length, 4)
        assert.ok(cols[0] instanceof DataGridTextColumn)
        assert.equal((cols[0] as DataGridTextColumn).BindingPath, 'Label')
        assert.equal(cols[0].Header, FieldSecurityView.FieldHeader)
        assert.ok(cols.slice(1).every(c => c instanceof DataGridTemplateColumn))
        assert.deepEqual(cols.slice(1).map(c => c.Header), [FieldSecurityView.ReadLabel, FieldSecurityView.UpdateLabel, FieldSecurityView.CreateLabel])
        assert.equal((view.Grid.ItemsSource as FieldGrantRow[]).length, 2)
        assert.equal(Fixtures.Rows(view).length, 2)
    })

    it('a realized cell is a Checkbox reflecting the grant; clicking flips it and the Dirty indicator', async () =>
    {
        const view = await Harness.Make()
        const read = Fixtures.Cell(view, Harness.SsnLabel, FieldPermission.Read)
        const update = Fixtures.Cell(view, Harness.SsnLabel, FieldPermission.Update)
        assert.equal(read.IsChecked, true)
        assert.equal(update.IsChecked, false)
        assert.equal(Fixtures.Texts(view).includes(FieldSecurityView.DirtyText), false)
        Fixtures.ClickButton(update)
        assert.equal(update.IsChecked, true)
        assert.ok(Fixtures.Texts(view).includes(FieldSecurityView.DirtyText))
        assert.equal(Fixtures.Rows(view).length, 2)
    })

    it('Save persists a toggled grant', async () =>
    {
        const src = new FakeSource()
        const view = await Harness.Make(src)
        Fixtures.ClickButton(Fixtures.Cell(view, Harness.TotalLabel, FieldPermission.Create))
        Fixtures.Click(view, FieldSecurityView.SaveLabel)
        await Fixtures.Settle()
        const grants = src.Saved!.fieldSecurity!.profiles[0].grants
        assert.equal(grants.find(g => g.concept === 'Order' && g.field === 'total')?.create, true)
    })

    it('renders a profile button per profile with the selected one marked, and delete-profile', async () =>
    {
        const view = await Harness.Make()
        const labels = Fixtures.Labels(view)
        assert.ok(labels.includes(FieldSecurityView.SelectedMark + 'Full'))
        assert.ok(labels.includes('Limited'))
        assert.ok(labels.includes(FieldSecurityView.DeleteProfileLabel))
        Fixtures.Click(view, 'Limited')
        assert.ok(Fixtures.Labels(view).includes(FieldSecurityView.SelectedMark + 'Limited'))
        assert.equal(Fixtures.Cell(view, Harness.SsnLabel, FieldPermission.Read).IsChecked, false)
    })

    it('renders add-profile and add-secured-field inputs and buttons, Save and Revert', async () =>
    {
        const view = await Harness.Make()
        assert.ok(Fixtures.Box(view, FieldSecurityView.ProfilePlaceholder))
        assert.ok(Fixtures.Box(view, FieldSecurityView.ConceptPlaceholder))
        assert.ok(Fixtures.Box(view, FieldSecurityView.FieldPlaceholder))
        const labels = Fixtures.Labels(view)
        for (const l of [FieldSecurityView.AddProfileLabel, FieldSecurityView.AddSecuredFieldLabel, FieldSecurityView.RemoveSecuredFieldLabel, FieldSecurityView.SaveLabel, FieldSecurityView.RevertLabel])
        {
            assert.ok(labels.includes(l), l)
        }
    })

    it('adds a secured field from the concept and field boxes', async () =>
    {
        const view = await Harness.Make()
        Fixtures.Box(view, FieldSecurityView.ConceptPlaceholder)!.Text = 'Account'
        Fixtures.Box(view, FieldSecurityView.FieldPlaceholder)!.Text = 'iban'
        Fixtures.Click(view, FieldSecurityView.AddSecuredFieldLabel)
        const labels = (view.Grid.ItemsSource as FieldGrantRow[]).map(r => r.Label)
        assert.ok(labels.includes('Account · iban'))
        assert.equal(Fixtures.Rows(view).length, 3)
        assert.ok(Fixtures.Texts(view).includes(FieldSecurityView.DirtyText))
    })

    it('adds a profile from the profile box', async () =>
    {
        const view = await Harness.Make()
        Fixtures.Box(view, FieldSecurityView.ProfilePlaceholder)!.Text = 'Audit'
        Fixtures.Click(view, FieldSecurityView.AddProfileLabel)
        assert.ok(Fixtures.Labels(view).some(l => l.includes('Audit')))
    })

    it('removes the selected grid row', async () =>
    {
        const view = await Harness.Make()
        const rows = view.Grid.ItemsSource as FieldGrantRow[]
        view.Grid.SelectedItem = rows[0]
        Fixtures.Click(view, FieldSecurityView.RemoveSecuredFieldLabel)
        const after = (view.Grid.ItemsSource as FieldGrantRow[]).map(r => r.Label)
        assert.deepEqual(after, [Harness.TotalLabel])
        assert.equal(Fixtures.Rows(view).length, 1)
    })

    it('mutating controls are no-ops while a save is in flight', async () =>
    {
        const src = new FakeSource()
        const view = await Harness.Make(src)
        let release: () => void = () => {}
        src.SetSecurityModel = (): Promise<void> => new Promise<void>(r => { release = r })
        Fixtures.ClickButton(Fixtures.Cell(view, Harness.SsnLabel, FieldPermission.Update))
        Fixtures.Click(view, FieldSecurityView.SaveLabel)
        await Fixtures.Settle()
        const count = Fixtures.Labels(view).length
        const cell = Fixtures.Cell(view, Harness.TotalLabel, FieldPermission.Read)
        Fixtures.ClickButton(cell)
        assert.equal(cell.IsChecked, false)
        Fixtures.Click(view, 'Limited')
        assert.ok(Fixtures.Labels(view).includes(FieldSecurityView.SelectedMark + 'Full'))
        Fixtures.Click(view, FieldSecurityView.DeleteProfileLabel)
        assert.equal(Fixtures.Labels(view).length, count)
        Fixtures.Box(view, FieldSecurityView.ConceptPlaceholder)!.Text = 'Account'
        Fixtures.Box(view, FieldSecurityView.FieldPlaceholder)!.Text = 'iban'
        Fixtures.Click(view, FieldSecurityView.AddSecuredFieldLabel)
        view.Grid.SelectedItem = (view.Grid.ItemsSource as FieldGrantRow[])[0]
        Fixtures.Click(view, FieldSecurityView.RemoveSecuredFieldLabel)
        assert.equal((view.Grid.ItemsSource as FieldGrantRow[]).length, 2)
        release()
        await Fixtures.Settle()
    })

    it('renders Loading before the first refresh', () =>
    {
        const view = new FieldSecurityView(new FakeSource())
        assert.ok(Fixtures.Texts(view).includes(FieldSecurityView.LoadingText))
    })

    it('renders Empty, Error and PermissionDenied states distinctly', async () =>
    {
        const emptySrc = new FakeSource()
        emptySrc.Model = { ...emptySrc.Model!, fieldSecurity: { ...emptySrc.Model!.fieldSecurity!, profiles: [] } }
        const empty = Fixtures.Texts(await Harness.Make(emptySrc))
        assert.ok(empty.includes(FieldSecurityView.EmptyText))
        assert.equal(empty.includes(FieldSecurityView.PermissionDeniedText), false)

        const badSrc = new FakeSource()
        badSrc.GetError = new Error('boom')
        const bad = Fixtures.Texts(await Harness.Make(badSrc))
        assert.ok(bad.includes('boom'))
        assert.equal(bad.includes(FieldSecurityView.EmptyText), false)
        assert.equal(bad.includes(FieldSecurityView.PermissionDeniedText), false)

        const deniedSrc = new FakeSource()
        deniedSrc.GetError = new TenantApiError(403, 'forbidden')
        const denied = Fixtures.Texts(await Harness.Make(deniedSrc))
        assert.ok(denied.includes(FieldSecurityView.PermissionDeniedText))
        assert.equal(denied.includes(FieldSecurityView.EmptyText), false)
        assert.equal(denied.includes('forbidden'), false)
    })

    it('Dispose does not throw', async () =>
    {
        const view = await Harness.Make()
        view.Dispose()
    })
})
