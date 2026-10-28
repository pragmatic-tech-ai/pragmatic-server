import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Button } from '@pragmatic-tech-ai/mural/framework'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { PrivilegeRow } from '../src/privilege-row.js'
import { ScreenState } from '../src/kit/screen-host.js'
import { AccessLevel, FieldPermission, LevelCycle, PrivilegeAction, SecurityModelDraft } from '../src/security-model-draft.js'
import { SecurityModelView } from '../src/security-model-view.js'
import { TenantApiError } from '../src/tenant-api-client.js'
import type { ISecurityModelEnvSource } from '../src/security-model-view-model.js'
import type { EnvironmentDto, ITenantNavigator, SecurityModelDto } from '../src/tenant-types.js'

class Fixtures
{
    private static app: Application | undefined

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
        for (const c of n.Children ?? [])
        {
            out.push(...Fixtures.Texts(c))
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
        for (const c of n.Children ?? [])
        {
            Fixtures.Buttons(c, out)
        }
        return out
    }

    public static ClickButton(b: unknown): void
    {
        (b as { fireClick(a: unknown): void }).fireClick({})
    }

    public static Click(root: unknown, label: string): void
    {
        const b = Fixtures.Buttons(root).find(x => Fixtures.Texts(x).join('') === label)
        assert.ok(b, 'button ' + label)
        Fixtures.ClickButton(b)
    }

    public static async Settle(): Promise<void>
    {
        await new Promise(r => setTimeout(r, 0))
    }
}

class FakeSource implements ISecurityModelEnvSource
{
    public Saves = 0
    public Saved: SecurityModelDto | undefined
    public SetError: Error | undefined
    public ListError: Error | undefined
    public GetError: Error | undefined
    public SaveGate: Promise<void> | undefined
    public Model: SecurityModelDto | null = {
        businessUnits: [],
        teams: [],
        membership: { claimsMapping: [], overrides: [] },
        ownershipRules: [],
        roles: [
            {
                id: 'r1',
                name: 'Admin',
                privileges: [
                    { action: PrivilegeAction.Read, concept: 'Customer', level: AccessLevel.Organization },
                    { action: PrivilegeAction.Update, concept: 'Customer', level: AccessLevel.BusinessUnit }
                ]
            },
            { id: 'r2', name: 'Viewer', privileges: [] }
        ],
        fieldSecurity: {
            securedFields: [{ concept: 'Customer', field: 'ssn' }],
            profiles: [
                { id: 'p1', name: 'Full', grants: [{ concept: 'Customer', field: 'ssn', read: true }] },
                { id: 'p2', name: 'Limited', grants: [] }
            ],
            profileAssignment: { claimsMapping: [], overrides: [], teamProfiles: [] }
        }
    }

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        if (this.ListError !== undefined)
        {
            throw this.ListError
        }
        return [{ name: 'dev' } as EnvironmentDto]
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
        this.Saves++
        await this.SaveGate
        if (this.SetError !== undefined)
        {
            throw this.SetError
        }
        this.Saved = model
    }
}

class FakeNav
{
    public LoginCalls = 0

    public ShowLogin(): void
    {
        this.LoginCalls++
    }
}

class Harness
{
    public static readonly SsnLabel = 'Customer \u00b7 ssn'

    public static async Make(src = new FakeSource(), nav = new FakeNav()): Promise<SecurityModelView>
    {
        Fixtures.InitApp()
        const view = new SecurityModelView(src)
        view.AttachNavigator(nav as unknown as ITenantNavigator)
        await view.Refresh()
        return view
    }

    public static Row(concept: string): PrivilegeRow
    {
        const draft = SecurityModelDraft.From(new FakeSource().Model)
        draft.SelectedRoleId = 'r1'
        return new PrivilegeRow(concept, draft)
    }
}

describe('SecurityModelView', () =>
{
    it('renders a role list and two sub-tabs (What they can do / Fields)', async () =>
    {
        const view = await Harness.Make()
        const strip = [...view.Tabs.Children][0]
        const labels = Fixtures.Buttons(strip).map(b => Fixtures.Texts(b).join(''))
        assert.deepEqual(labels, [SecurityModelView.WhatTheyCanDoLabel, SecurityModelView.FieldsLabel])
        const all = Fixtures.Texts(view)
        assert.ok(all.includes(SecurityModelView.SelectedMark + 'Admin'))
        assert.ok(all.includes('Viewer'))
    })

    it('the privilege matrix cycles a cell level in place and sets Dirty', async () =>
    {
        const view = await Harness.Make()
        const cell = view.CellFor('Customer', PrivilegeAction.Create)
        assert.ok(cell)
        assert.equal(view.Vm.Dirty, false)
        Fixtures.ClickButton(cell)
        assert.equal(view.Vm.Dirty, true)
        const next = LevelCycle[1]
        assert.equal(view.Vm.PrivilegeRows[0].LevelFor(PrivilegeAction.Create), next)
        assert.equal(Fixtures.Texts(cell).join(''), SecurityModelView.SymbolOf(next))
    })

    it('SentenceFor names every granted action and level in plain words', () =>
    {
        const sentence = SecurityModelView.SentenceFor(Harness.Row('Customer'))
        assert.match(sentence, /read/)
        assert.match(sentence, /organization/)
        assert.match(sentence, /update/)
        assert.match(sentence, /business unit/)
        assert.doesNotMatch(sentence, /delete/)
    })

    it('SentenceFor says the role cannot see a concept with no access', () =>
    {
        const sentence = SecurityModelView.SentenceFor(Harness.Row('Order'))
        assert.equal(sentence, SecurityModelView.NoAccessSentence)
    })

    it('the Fields tab lists profiles and toggling a grant updates the draft and Dirty', async () =>
    {
        const view = await Harness.Make()
        const labels = Fixtures.Buttons(view.FieldHost).map(b => Fixtures.Texts(b).join(''))
        assert.ok(labels.includes(SecurityModelView.SelectedMark + 'Full'))
        assert.ok(labels.includes('Limited'))
        const update = view.GrantBox(Harness.SsnLabel, FieldPermission.Update)
        const read = view.GrantBox(Harness.SsnLabel, FieldPermission.Read)
        assert.equal(read?.IsChecked, true)
        assert.equal(update?.IsChecked, false)
        assert.equal(view.Vm.Dirty, false)
        Fixtures.ClickButton(update)
        assert.equal(view.Vm.FieldRows[0].IsGranted(FieldPermission.Update), true)
        assert.equal(view.Vm.Dirty, true)
    })

    it('the save bar shows unsaved state; Save persists once; Discard reverts', async () =>
    {
        const src = new FakeSource()
        const view = await Harness.Make(src)
        assert.equal(view.SaveBarText, SecurityModelView.NoChangesText)
        assert.equal(view.SaveEnabled, false)
        assert.equal(view.DiscardEnabled, false)
        Fixtures.ClickButton(view.CellFor('Customer', PrivilegeAction.Create))
        assert.equal(view.SaveBarText, SecurityModelView.UnsavedText)
        assert.equal(view.SaveEnabled, true)
        assert.equal(view.DiscardEnabled, true)
        Fixtures.Click(view, SecurityModelView.DiscardLabel)
        await Fixtures.Settle()
        assert.equal(view.Vm.Dirty, false)
        assert.equal(view.SaveBarText, SecurityModelView.NoChangesText)
        assert.equal(src.Saves, 0)
        Fixtures.ClickButton(view.CellFor('Customer', PrivilegeAction.Create))
        Fixtures.Click(view, SecurityModelView.SaveLabel)
        await Fixtures.Settle()
        assert.equal(src.Saves, 1)
        assert.equal(view.Vm.Dirty, false)
    })

    it('an empty model shows the empty state with Add role', async () =>
    {
        const src = new FakeSource()
        src.Model = { ...src.Model!, roles: [], fieldSecurity: undefined }
        const view = await Harness.Make(src)
        assert.equal(view.StateHost.State, ScreenState.Empty)
        assert.ok(Fixtures.Texts(view).includes(SecurityModelView.EmptyTitle))
        const labels = Fixtures.Buttons(view).map(b => Fixtures.Texts(b).join(''))
        assert.ok(labels.includes(SecurityModelView.AddRoleLabel))
        assert.ok(labels.includes(SecurityModelView.AddProfileLabel))
    })

    it('refuses mutating clicks while a save is in flight', async () =>
    {
        const src = new FakeSource()
        const view = await Harness.Make(src)
        Fixtures.ClickButton(view.CellFor('Customer', PrivilegeAction.Create))
        let release: () => void = () => undefined
        src.SaveGate = new Promise<void>(r => { release = r })
        Fixtures.Click(view, SecurityModelView.SaveLabel)
        assert.equal(view.Vm.Busy, true)
        const before = view.Vm.PrivilegeRows[0].LevelFor(PrivilegeAction.Delete)
        Fixtures.ClickButton(view.CellFor('Customer', PrivilegeAction.Delete))
        assert.equal(view.Vm.PrivilegeRows[0].LevelFor(PrivilegeAction.Delete), before)
        const box = view.GrantBox(Harness.SsnLabel, FieldPermission.Update)
        Fixtures.ClickButton(box)
        assert.equal(box?.IsChecked, false)
        assert.equal(view.Vm.FieldRows[0].IsGranted(FieldPermission.Update), false)
        release()
        await Fixtures.Settle()
        assert.equal(view.Vm.Busy, false)
    })

    it('403 shows the denied state naming the permission', async () =>
    {
        const src = new FakeSource()
        src.GetError = new TenantApiError(403, 'no')
        const view = await Harness.Make(src)
        assert.ok(view.DeniedHost)
        assert.equal(view.DeniedHost.State, ScreenState.Denied)
        assert.ok(Fixtures.Texts(view).join(' ').includes(SecurityModelView.DeniedNeed))
    })

    it('401 routes to login for both load and save', async () =>
    {
        const src = new FakeSource()
        const nav = new FakeNav()
        src.ListError = new TenantApiError(401, 'expired')
        await Harness.Make(src, nav)
        assert.equal(nav.LoginCalls, 1)

        const src2 = new FakeSource()
        const nav2 = new FakeNav()
        const view = await Harness.Make(src2, nav2)
        src2.SetError = new TenantApiError(401, 'expired')
        Fixtures.ClickButton(view.CellFor('Customer', PrivilegeAction.Create))
        Fixtures.Click(view, SecurityModelView.SaveLabel)
        await Fixtures.Settle()
        assert.equal(nav2.LoginCalls, 1)
    })
})
