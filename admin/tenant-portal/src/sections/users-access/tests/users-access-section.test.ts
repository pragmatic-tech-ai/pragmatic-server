import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { ConfirmDialogViewModel } from '../../../shell/confirm-dialog-view-model.js'
import { PendingWork, type IHoldsPendingWork } from '../../../shell/holds-pending-work.js'
import { TenantPageViewModel, PageState } from '../../../shell/tenant-page-view-model.js'
import { TenantSectionService } from '../../../shell/tenant-section-service.js'
import type { TenantSessionService } from '../../../shell/tenant-session-service.js'
import { FakeTenantApi, Inspect, TenantTestHost, TestRail, Tick, type FakeDialogService } from '../../../shell/tests/tenant-test-fixtures.js'
import { TenantRole, type AdminCapabilitiesDto } from '../../../tenant-types.js'
import { AccountDetailPageViewModel } from '../account-detail-page-view-model.js'
import { CreateAccountDialogViewModel } from '../create-account-dialog-view-model.js'
import { IssueTokenDialogViewModel } from '../issue-token-dialog-view-model.js'
import { TokenDuration, TokenDurations } from '../token-duration.js'
import { TokenRevealPageViewModel } from '../token-reveal-page-view-model.js'
import { TokenStatus } from '../tokens-tab-view-model.js'
import { UsersAccessPageViewModel, UsersAccessTab } from '../users-access-page-view-model.js'
import { UsersAccessSectionService } from '../users-access-section-service.js'

class OtherPage extends TenantPageViewModel
{
    public constructor(session: TenantSessionService)
    {
        super(session)
    }

    protected override async LoadCore(): Promise<boolean>
    {
        return true
    }
}

class OtherSection extends TenantSectionService
{
    public static readonly Key = new ServiceKey<OtherSection>('OtherSection')

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    protected override CreateRoot(): TenantPageViewModel
    {
        return new OtherPage(this.Session)
    }
}

// Marks an object as holding unsaved work, as the security-model editor
// does once it has a draft.
class PendingFlag
{
    public static Hold(target: object): { Pending: boolean }
    {
        const flag = { Pending: true }
        Object.defineProperty(target, 'HasPendingWork', { get: () => flag.Pending, configurable: true })
        PendingWork.Register(target as IHoldsPendingWork)
        return flag
    }
}

class Fixture
{
    public static readonly NoAccess: AdminCapabilitiesDto = { envs: true, adopt: true, access: false, settings: true }

    public readonly Api = new FakeTenantApi().WithEnvironment('alpha').WithEnvironment('beta')
    public readonly Host: TenantTestHost
    public readonly Dialogs: FakeDialogService

    public constructor(capabilities: AdminCapabilitiesDto = TenantTestHost.AllCapabilities)
    {
        this.Api.Snapshots.set('alpha', {
            accounts: [
                { principalId: 'principal-1', email: 'owner@example.test', disabled: false },
                { principalId: 'p2', email: 'jane@example.test', disabled: false },
            ],
            grants: [
                { subject: 'principal-1', role: 'Owner', resourceKind: 'tenant', resourcePath: [] },
                { subject: 'p2', role: 'Viewer', resourceKind: 'tenant', resourcePath: [] },
                { subject: 'p2', role: 'Editor', resourceKind: 'model', resourcePath: ['sales', 'eu'] },
            ],
        })
        this.Api.Tokens.set('alpha', [
            { tokenRef: 'tok-a', principalId: 'p2', scopes: ['read', 'write'], expiresAt: null, revoked: false },
            { tokenRef: 'tok-b', principalId: 'p2', scopes: ['read'], expiresAt: '2020-01-01T00:00:00.000Z', revoked: false },
            { tokenRef: 'tok-c', principalId: 'p2', scopes: ['read'], expiresAt: null, revoked: true },
        ])
        this.Host = new TenantTestHost(this.Api, capabilities)
        this.Dialogs = this.Host.UseDialogs()
        this.Host.Provider.register(UsersAccessSectionService.Key, (p) => new UsersAccessSectionService(p))
    }

    public get Section(): UsersAccessSectionService
    {
        return this.Host.Provider.getRequired(UsersAccessSectionService.Key)
    }

    public async Open(): Promise<UsersAccessPageViewModel>
    {
        this.Section.OnActivated()
        await Tick.Settle()
        const root = this.Section.Root
        assert.ok(root !== undefined)
        return root
    }

    public LastConfirm(): ConfirmDialogViewModel
    {
        const last = this.Dialogs.Last
        assert.ok(last instanceof ConfirmDialogViewModel)
        return last
    }

    public get LastTitle(): string | undefined
    {
        return this.Dialogs.Shown[this.Dialogs.Shown.length - 1]?.Title
    }

    public async OpenAccount(principalId: string): Promise<AccountDetailPageViewModel>
    {
        await this.Open()
        this.Section.OpenAccount('alpha', principalId)
        await Tick.Settle()
        const detail = this.Section.Current
        assert.ok(detail instanceof AccountDetailPageViewModel)
        return detail
    }

    public async IssueFromTokensTab(): Promise<TokenRevealPageViewModel>
    {
        const page = await this.Open()
        page.SelectedTab = 'Tokens'
        await Tick.Settle()
        page.IssueTokenCommand.Execute()
        await Tick.Settle()
        const dialog = this.Dialogs.Last
        assert.ok(dialog instanceof IssueTokenDialogViewModel)
        dialog.PrincipalId = 'ci-bot'
        dialog.Scopes = 'read, write deploy'
        await dialog.Confirm()
        await Tick.Settle()
        const reveal = this.Section.Current
        assert.ok(reveal instanceof TokenRevealPageViewModel)
        return reveal
    }
}

describe('UsersAccessPageViewModel', () =>
{
    it('is wholly denied without the Manage users & access permission: nothing loads, no dialog opens', async () =>
    {
        const f = new Fixture(Fixture.NoAccess)
        const page = await f.Open()
        assert.equal(page.State, PageState.Denied)
        assert.equal(f.Api.Count('ListEnvironments'), 0)
        assert.equal(f.Api.Count('GetAdminSnapshot'), 0)
        assert.equal(page.CreateAccountCommand.CanExecute(), false)
        assert.equal(page.IssueTokenCommand.CanExecute(), false)
        page.CreateAccountCommand.Execute()
        page.SelectedTab = 'Tokens'
        page.IssueTokenCommand.Execute()
        await Tick.Settle()
        assert.equal(f.Dialogs.Shown.length, 0)
        assert.equal(f.Api.Count('ListTokens'), 0)
        assert.equal(page.DeniedPageText,
            'This needs the Manage users & access permission. Ask owner@example.test. Nothing here was changed.')
        assert.match(page.DeniedReason, /Manage users & access/)
    })

    it('is Empty when the tenant has no environments', async () =>
    {
        const f = new Fixture()
        f.Api.Environments = []
        const page = await f.Open()
        assert.equal(page.State, PageState.Empty)
        assert.equal(f.Api.Count('GetAdminSnapshot'), 0)
    })

    it('selects the first environment, loads only the shown tab, and pushes environment changes to loaded tabs', async () =>
    {
        const f = new Fixture()
        const page = await f.Open()
        assert.equal(page.State, PageState.Populated)
        assert.deepEqual(page.Environments.ToArray().map(o => o.Label), ['alpha', 'beta'])
        assert.equal(page.SelectedEnvironment?.Value, 'alpha')
        assert.equal(page.CurrentTab, page.UsersTab)
        assert.equal(page.UsersTab.Environment, 'alpha')
        assert.equal(page.TokensTab.Environment, undefined)
        assert.equal(f.Api.Count('ListTokens'), 0)

        page.SelectedTab = 'Tokens'
        await Tick.Settle()
        assert.equal(page.Tab, UsersAccessTab.Tokens)
        assert.equal(page.CurrentTab, page.TokensTab)
        assert.equal(page.IsTokensTab, true)
        assert.deepEqual(f.Api.Calls.filter(c => c[0] === 'ListTokens'), [['ListTokens', 'alpha']])

        page.SelectedEnvironment = page.Environments.ToArray()[1]
        await Tick.Settle()
        assert.equal(page.UsersTab.Environment, 'beta')
        assert.equal(page.TokensTab.Environment, 'beta')
        assert.equal(page.SecurityModelEditor.Environment, undefined)
        assert.equal(f.Api.Count('GetSecurityModel'), 0)

        page.SelectedTab = 'Roles & permissions'
        await Tick.Settle()
        assert.equal(page.SecurityModelEditor.Environment, 'beta')
    })

    it('replaces the environment options on reload and keeps the selection', async () =>
    {
        const f = new Fixture()
        const page = await f.Open()
        page.SelectedEnvironment = page.Environments.ToArray()[1]
        await Tick.Settle()
        const before = page.Environments
        await page.Refresh()
        assert.notEqual(page.Environments, before)
        assert.equal(page.SelectedEnvironment?.Value, 'beta')
        assert.ok(page.Environments.ToArray().includes(page.SelectedEnvironment!))
    })

    it('asks before switching environment over unsaved security-model changes; declined, the picker snaps back', async () =>
    {
        const f = new Fixture()
        const page = await f.Open()
        page.SelectedTab = 'Roles & permissions'
        await Tick.Settle()
        const flag = PendingFlag.Hold(page.SecurityModelEditor)
        const snaps: unknown[] = []
        page.PropertyChanged('SelectedEnvironment').subscribe(() => { snaps.push(page.SelectedEnvironment?.Value) })

        page.SelectedEnvironment = page.Environments.ToArray()[1]
        await Tick.Settle()
        const ask = f.LastConfirm()
        assert.equal(ask.Message, 'Discard unsaved changes to the security model?')
        ask.Cancel()
        await Tick.Settle()
        assert.equal(page.SelectedEnvironment?.Value, 'alpha')
        assert.deepEqual(snaps, ['alpha'])
        assert.equal(page.SecurityModelEditor.Environment, 'alpha')

        // A tab switch keeps the draft and does not ask.
        page.SelectedTab = 'Users'
        await Tick.Settle()
        assert.equal(f.Dialogs.Shown.length, 1)
        assert.equal(flag.Pending, true)

        page.SelectedEnvironment = page.Environments.ToArray()[1]
        await Tick.Settle()
        await f.LastConfirm().Confirm()
        await Tick.Settle()
        assert.equal(page.SelectedEnvironment?.Value, 'beta')
        assert.equal(page.SecurityModelEditor.Environment, 'beta')
        assert.equal(page.UsersTab.Environment, 'beta')
    })

    it('switches environment without asking when nothing is pending', async () =>
    {
        const f = new Fixture()
        const page = await f.Open()
        const flag = PendingFlag.Hold(page.SecurityModelEditor)
        flag.Pending = false
        page.SelectedEnvironment = page.Environments.ToArray()[1]
        await Tick.Settle()
        assert.equal(f.Dialogs.Shown.length, 0)
        assert.equal(page.UsersTab.Environment, 'beta')
    })
})

describe('Users tab', () =>
{
    it('lists accounts with their roles, status and the You marker', async () =>
    {
        const f = new Fixture()
        f.Api.Snapshots.get('alpha')!.accounts.push({ principalId: 'p3', email: 'gone@example.test', disabled: true })
        const page = await f.Open()
        const rows = page.UsersTab.Rows.ToArray()
        assert.equal(page.UsersTab.State, PageState.Populated)
        assert.deepEqual(rows.map(r => r.Email), ['owner@example.test', 'jane@example.test', 'gone@example.test'])
        assert.deepEqual(rows.map(r => r.RolesText), ['Owner', 'Viewer, Editor', 'No roles'])
        assert.deepEqual(rows.map(r => r.IsYou), [true, false, false])
        assert.deepEqual(rows.map(r => r.StatusLabel), ['Active', 'Active', 'Disabled'])
        rows[1].OpenCommand.Execute()
        await Tick.Settle()
        assert.ok(f.Section.Current instanceof AccountDetailPageViewModel)
        assert.equal((f.Section.Current as AccountDetailPageViewModel).Email, 'jane@example.test')
    })

    it('creates an account and does not keep the password', async () =>
    {
        const f = new Fixture()
        const page = await f.Open()
        page.CreateAccountCommand.Execute()
        await Tick.Settle()
        const dialog = f.Dialogs.Last
        assert.ok(dialog instanceof CreateAccountDialogViewModel)
        assert.equal(f.LastTitle, 'Create account')
        dialog.Email = 'new@example.test'
        dialog.PrincipalId = 'p9'
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        dialog.Password = 's3cret-pass'
        assert.equal(dialog.ConfirmCommand.CanExecute(), true)
        await dialog.Confirm()
        await Tick.Settle()
        assert.deepEqual(f.Api.Calls.find(c => c[0] === 'CreateAccount'),
            ['CreateAccount', 'alpha', { email: 'new@example.test', principalId: 'p9', password: 's3cret-pass' }])
        assert.equal(dialog.Password, '')
        assert.equal(page.UsersTab.Rows.Count, 3)
        assert.ok(!Inspect.ReachableStrings(dialog, [f.Api]).includes('s3cret-pass'))
    })

    it('clears a typed password when the dialog is dismissed', async () =>
    {
        const f = new Fixture()
        const page = await f.Open()
        page.CreateAccountCommand.Execute()
        await Tick.Settle()
        const dialog = f.Dialogs.Last as CreateAccountDialogViewModel
        dialog.Password = 'typed-then-left'
        f.Dialogs.Dismiss()
        await Tick.Settle()
        assert.equal(dialog.Password, '')
        assert.equal(f.Api.Count('CreateAccount'), 0)
    })
})

describe('AccountDetailPageViewModel', () =>
{
    it('shows the account and its grants, and grants a role (Viewer by default)', async () =>
    {
        const f = new Fixture()
        const detail = await f.OpenAccount('p2')
        assert.equal(detail.Email, 'jane@example.test')
        assert.equal(detail.StatusLabel, 'Active')
        assert.equal(detail.IsYou, false)
        assert.deepEqual(detail.Grants.ToArray().map(g => [g.Role, g.ResourceText]), [['Viewer', 'tenant'], ['Editor', 'model / sales / eu']])
        assert.equal(detail.SelectedRole?.Value, TenantRole.Viewer)
        assert.deepEqual(detail.Roles.ToArray().map(r => r.Label), ['Owner', 'Admin', 'Editor', 'Viewer', 'Maker'])
        detail.SelectedRole = detail.Roles.ToArray()[1]
        detail.GrantCommand.Execute()
        await Tick.Settle()
        assert.deepEqual(f.Api.Calls.find(c => c[0] === 'GrantRole'), ['GrantRole', 'alpha', { subject: 'p2', role: 'Admin' }])
        assert.equal(detail.Grants.Count, 3)
    })

    it('revokes another person\'s grant with a plain confirm', async () =>
    {
        const f = new Fixture()
        const detail = await f.OpenAccount('p2')
        detail.Grants.ToArray()[1].RevokeCommand.Execute()
        await Tick.Settle()
        const confirm = f.LastConfirm()
        assert.equal(confirm.Warning, '')
        await confirm.Confirm()
        await Tick.Settle()
        assert.deepEqual(f.Api.Calls.find(c => c[0] === 'RevokeRole'),
            ['RevokeRole', 'alpha', { subject: 'p2', role: 'Editor', resourceKind: 'model', resourcePath: ['sales', 'eu'] }])
        assert.equal(detail.Grants.Count, 1)
    })

    it('warns before revoking your own grant, and a declined confirm changes nothing', async () =>
    {
        const f = new Fixture()
        const detail = await f.OpenAccount('principal-1')
        assert.equal(detail.IsYou, true)
        detail.Grants.ToArray()[0].RevokeCommand.Execute()
        await Tick.Settle()
        const confirm = f.LastConfirm()
        assert.equal(confirm.Warning, 'This is your own grant; revoking it may reduce your access.')
        confirm.Cancel()
        await Tick.Settle()
        assert.equal(f.Api.Count('RevokeRole'), 0)
    })

    it('disables an account after a confirm listing the consequences', async () =>
    {
        const f = new Fixture()
        const detail = await f.OpenAccount('p2')
        detail.DisableCommand.Execute()
        await Tick.Settle()
        const confirm = f.LastConfirm()
        assert.equal(f.LastTitle, 'Disable account')
        assert.equal(confirm.ConsequencesText,
            "- They are signed out everywhere and can't sign in.\n- Their records and history stay. Their tokens stop working.")
        assert.equal(confirm.Warning, '')
        await confirm.Confirm()
        await Tick.Settle()
        assert.deepEqual(f.Api.Calls.find(c => c[0] === 'DisableAccount'), ['DisableAccount', 'alpha', 'p2'])
        assert.equal(detail.StatusLabel, 'Disabled')
        assert.equal(detail.DisableCommand.CanExecute(), false)
    })

    it('warns before disabling your own account', async () =>
    {
        const f = new Fixture()
        const detail = await f.OpenAccount('principal-1')
        detail.DisableCommand.Execute()
        await Tick.Settle()
        assert.equal(f.LastConfirm().Warning, 'This is your own account; disabling it will lock you out.')
    })

    it('denies every action without the permission and opens no dialog', async () =>
    {
        const f = new Fixture(Fixture.NoAccess)
        const detail = await f.OpenAccount('p2')
        for (const command of [detail.GrantCommand, detail.DisableCommand, detail.IssueTokenCommand, ...detail.Grants.ToArray().map(g => g.RevokeCommand)])
        {
            assert.equal(command.CanExecute(), false)
            command.Execute()
        }
        await Tick.Settle()
        assert.equal(f.Dialogs.Shown.length, 0)
        assert.match(detail.DeniedReason, /Manage users & access/)
    })

    it('issues a token prefilled with the account, then returns to the Users & Access page on Done', async () =>
    {
        const f = new Fixture()
        const detail = await f.OpenAccount('p2')
        detail.IssueTokenCommand.Execute()
        await Tick.Settle()
        const dialog = f.Dialogs.Last
        assert.ok(dialog instanceof IssueTokenDialogViewModel)
        assert.equal(dialog.PrincipalId, 'p2')
        dialog.Scopes = 'read'
        await dialog.Confirm()
        await Tick.Settle()
        const reveal = f.Section.Current
        assert.ok(reveal instanceof TokenRevealPageViewModel)
        reveal.Saved = true
        reveal.ConfirmSavedCommand.Execute()
        await Tick.Settle()
        assert.equal(f.Section.Current, f.Section.Root)
        assert.equal(f.Section.Root?.Tab, UsersAccessTab.Tokens)
        assert.equal(f.Section.Root?.TokensTab.Rows.Count, 4)
    })
})

describe('Tokens tab', () =>
{
    it('lists tokens with their status and revokes after a confirm', async () =>
    {
        const f = new Fixture()
        const page = await f.Open()
        page.SelectedTab = 'Tokens'
        await Tick.Settle()
        const rows = page.TokensTab.Rows.ToArray()
        assert.deepEqual(rows.map(r => r.Status), [TokenStatus.Active, TokenStatus.Expired, TokenStatus.Revoked])
        assert.deepEqual(rows.map(r => r.ScopesText), ['read, write', 'read', 'read'])
        assert.equal(rows[0].ExpiresText, 'Never')
        assert.equal(rows[2].RevokeCommand.CanExecute(), false)
        rows[0].RevokeCommand.Execute()
        await Tick.Settle()
        const confirm = f.LastConfirm()
        assert.equal(f.LastTitle, 'Revoke service token')
        assert.equal(confirm.Message, 'This token stops working immediately. Anything using it will start failing.')
        assert.equal(confirm.ConfirmLabel, 'Revoke token')
        await confirm.Confirm()
        await Tick.Settle()
        assert.deepEqual(f.Api.Calls.find(c => c[0] === 'RevokeToken'), ['RevokeToken', 'alpha', 'tok-a'])
        assert.equal(page.TokensTab.Rows.ToArray()[0].Status, TokenStatus.Revoked)
        assert.equal(page.TokensTab.Rows.ToArray()[0].RevokeCommand.CanExecute(), false)
    })

    it('requires a principal and at least one scope, and maps the duration', async () =>
    {
        const f = new Fixture()
        const dialog = new IssueTokenDialogViewModel(f.Host.Session, f.Dialogs, 'alpha')
        assert.equal(dialog.SelectedDuration?.Label, '1 day')
        assert.deepEqual(dialog.Durations.ToArray().map(d => d.Label), ['1 hour', '1 day', '30 days', 'Never expires'])
        dialog.PrincipalId = 'ci-bot'
        assert.equal(dialog.ScopesErrorText, '')
        dialog.Scopes = ' , '
        assert.equal(dialog.ScopesErrorText, 'At least one scope is required.')
        assert.equal(dialog.ConfirmCommand.CanExecute(), false)
        dialog.Scopes = 'a,b c'
        assert.deepEqual(dialog.ParsedScopes, ['a', 'b', 'c'])
        assert.equal(dialog.ConfirmCommand.CanExecute(), true)
        assert.equal(TokenDurations.SecondsFor(TokenDuration.OneHour), 3600)
        assert.equal(TokenDurations.SecondsFor(TokenDuration.OneDay), 86400)
        assert.equal(TokenDurations.SecondsFor(TokenDuration.ThirtyDays), 2592000)
        assert.equal(TokenDurations.SecondsFor(TokenDuration.Never), null)
    })

    it('issues a token, reveals it once, gates Done on "I\'ve saved it" and clears it after', async () =>
    {
        const f = new Fixture()
        const reveal = await f.IssueFromTokensTab()
        const issue = f.Api.Calls.find(c => c[0] === 'IssueToken')
        assert.deepEqual(issue, ['IssueToken', 'alpha', { principalId: 'ci-bot', scopes: ['read', 'write', 'deploy'], expiresInSeconds: 86400 }])
        assert.equal(reveal.Value, 'fixture-issued-token')
        assert.equal(reveal.HasPendingSecret, true)
        assert.equal(reveal.ConfirmSavedCommand.CanExecute(), false)
        reveal.ConfirmSavedCommand.Execute()
        assert.equal(reveal.Value, 'fixture-issued-token')
        // Only the reveal holds it: reachable from the section through it, not from the closed dialog.
        assert.ok(Inspect.ReachableStrings(f.Section, [f.Api]).includes('fixture-issued-token'))
        assert.ok(!Inspect.ReachableStrings(f.Dialogs.Last as object, [f.Api, f.Host.Provider]).includes('fixture-issued-token'))
        reveal.Saved = true
        assert.equal(reveal.ConfirmSavedCommand.CanExecute(), true)
        const listsBefore = f.Api.Count('ListTokens')
        reveal.ConfirmSavedCommand.Execute()
        await Tick.Settle()
        assert.equal(reveal.Value, '')
        assert.equal(reveal.HasPendingSecret, false)
        assert.equal(f.Section.Current, f.Section.Root)
        assert.equal(f.Section.Root?.Tab, UsersAccessTab.Tokens)
        assert.equal(f.Api.Count('ListTokens'), listsBefore + 1)
        // No copy survives anywhere the section (or the closed dialog) can reach.
        assert.ok(!Inspect.ReachableStrings(f.Section, [f.Api]).includes('fixture-issued-token'))
        assert.ok(!Inspect.ReachableStrings(f.Dialogs, [f.Api]).includes('fixture-issued-token'))
    })

    it('keeps the unconfirmed reveal current across a rail round-trip', async () =>
    {
        const f = new Fixture()
        f.Host.Provider.register(OtherSection.Key, (p) => new OtherSection(p))
        const rail = new TestRail(f.Host.Provider)
        rail.Add(UsersAccessSectionService.Key)
        rail.Add(OtherSection.Key)
        rail.Select(UsersAccessSectionService.Key)
        await Tick.Settle()
        const reveal = await f.IssueFromTokensTab()
        rail.Select(OtherSection.Key)
        await Tick.Settle()
        rail.Select(UsersAccessSectionService.Key)
        await Tick.Settle()
        assert.equal(f.Section.Current, reveal)
        assert.equal(reveal.Value, 'fixture-issued-token')
        assert.equal(f.Host.Host.Content, reveal)
        f.Section.Back()
        assert.equal(f.Section.Current, reveal)
    })
})
