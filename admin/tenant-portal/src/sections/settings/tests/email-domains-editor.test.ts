import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ToVisibility, Visibility } from '@pragmatic-tech-ai/mural/runtime'
import { TenantApiError } from '../../../tenant-api-client.js'
import { FakeTenantApi, TenantTestHost } from '../../../shell/tests/tenant-test-fixtures.js'
import { EmailDomainsEditorViewModel } from '../email-domains-editor-view-model.js'

class Fixture
{
    public static Editor(api: FakeTenantApi, host: TenantTestHost = new TenantTestHost(api)): EmailDomainsEditorViewModel
    {
        return new EmailDomainsEditorViewModel(host.Session)
    }

    public static async Loaded(api: FakeTenantApi, canChangeSettings: boolean = true): Promise<EmailDomainsEditorViewModel>
    {
        const editor = Fixture.Editor(api)
        editor.Apply(await api.GetEmailDomains(), canChangeSettings)
        api.Calls.length = 0
        return editor
    }
}

describe('EmailDomainsEditorViewModel', () =>
{
    it('the Owner saves the domains', async () =>
    {
        const api = new FakeTenantApi()
        const editor = await Fixture.Loaded(api)
        assert.equal(editor.IsEditable, true)
        assert.equal(editor.DomainsText, 'acme.test')
        editor.DomainsText = 'Acme.test, beta.test'
        await editor.Save()
        assert.deepEqual(api.Calls, [['SetEmailDomains', ['Acme.test', 'beta.test']]])
        assert.equal(editor.SavedText, 'Saved.')
        assert.equal(editor.ErrorText, '')
        assert.equal(editor.DomainsText, 'acme.test, beta.test')
        assert.equal(editor.SaveCommand.CanExecute(undefined), false)
    })

    it('a server refusal shows its sentence', async () =>
    {
        const api = new FakeTenantApi()
        const editor = await Fixture.Loaded(api)
        api.FailOn.set('SetEmailDomains', new TenantApiError(400, 'gmail.com is a public mail domain and cannot be used'))
        editor.DomainsText = 'gmail.com'
        await editor.Save()
        assert.equal(editor.ErrorText, 'gmail.com is a public mail domain and cannot be used')
        assert.equal(editor.SavedText, '')
        assert.equal(editor.DomainsText, 'gmail.com')
        assert.equal(editor.SaveCommand.CanExecute(undefined), true)
    })

    it('a 401 on save expires the session without a sentence', async () =>
    {
        const api = new FakeTenantApi()
        const host = new TenantTestHost(api)
        const editor = Fixture.Editor(api, host)
        editor.Apply(await api.GetEmailDomains(), true)
        api.FailOn.set('SetEmailDomains', new TenantApiError(401, 'gone'))
        editor.DomainsText = 'beta.test'
        await editor.Save()
        assert.equal(host.Reloader.Count, 1)
        assert.equal(editor.ErrorText, '')
    })

    it('a non-Owner sees the domains read-only with the Owner sentence', async () =>
    {
        const api = new FakeTenantApi()
        const editor = await Fixture.Loaded(api, false)
        assert.equal(editor.IsEditable, false)
        assert.equal(editor.DomainsText, 'acme.test')
        assert.equal(editor.ReadOnlyText, 'Only the tenant Owner can change the email domains.')
        editor.DomainsText = 'beta.test'
        await editor.Save()
        assert.equal(api.Count('SetEmailDomains'), 0)
    })

    it('a not-editable store shows the in-hive sentence', async () =>
    {
        const api = new FakeTenantApi()
        api.EmailDomains = { domains: ['acme.test'], editable: false, inHive: false, pending: [] }
        const editor = await Fixture.Loaded(api)
        assert.equal(editor.IsEditable, false)
        assert.equal(editor.ReadOnlyText, "This tenant's email domains are set in its in-hive console.")
        assert.equal(editor.SaveCommand.CanExecute(undefined), false)
    })

    it('Save is disabled until the list changes', async () =>
    {
        const api = new FakeTenantApi()
        const editor = await Fixture.Loaded(api)
        assert.equal(editor.SaveCommand.CanExecute(undefined), false)
        editor.DomainsText = 'acme.test, beta.test'
        assert.equal(editor.SaveCommand.CanExecute(undefined), true)
        editor.DomainsText = 'acme.test'
        assert.equal(editor.SaveCommand.CanExecute(undefined), false)
    })

    it('an in-hive console, which cannot see approvals, always says a domain needs the operator\'s approval', async () =>
    {
        const api = new FakeTenantApi()
        const plain = await Fixture.Loaded(api)
        assert.equal(plain.IsInHive, false)
        assert.equal(plain.ApprovalText, '')
        api.EmailDomains = { domains: ['acme.test'], editable: true, inHive: true, pending: [] }
        const editor = await Fixture.Loaded(api)
        assert.equal(editor.IsInHive, true)
        assert.equal(editor.ApprovalText, 'A domain only takes effect after the platform operator approves it.')
        editor.ApplyUnavailable()
        assert.equal(editor.IsInHive, false)
        assert.equal(editor.ApprovalText, '')
    })

    it('a control-plane tenant names the domains still waiting for the operator\'s approval', async () =>
    {
        const api = new FakeTenantApi()
        api.EmailDomains = { domains: ['acme.test', 'beta.test', 'gamma.test'], editable: true, inHive: false, pending: ['beta.test', 'gamma.test'] }
        const editor = await Fixture.Loaded(api)
        assert.equal(editor.ApprovalText,
            'Waiting for the platform operator to approve: beta.test, gamma.test. A domain only takes effect after the platform operator approves it.')
        editor.DomainsText = 'acme.test, beta.test, gamma.test, delta.test'
        await editor.Save()
        assert.equal(editor.ApprovalText,
            'Waiting for the platform operator to approve: beta.test, delta.test, gamma.test. A domain only takes effect after the platform operator approves it.')
        editor.ApplyFailure('The tenant records are unavailable.')
        assert.equal(editor.ApprovalText, '')
    })

    it('ToVisibility collapses an empty string and shows a sentence', () =>
    {
        assert.equal(ToVisibility.convert(''), Visibility.Collapsed)
        assert.equal(ToVisibility.convert('Saved.'), Visibility.Visible)
    })

    it('an unavailable route leaves it read-only with its sentence, and a failure shows its sentence alone', () =>
    {
        const editor = Fixture.Editor(new FakeTenantApi())
        editor.ApplyUnavailable()
        assert.equal(editor.IsEditable, false)
        assert.equal(editor.ReadOnlyText, 'Email domains are not available here.')
        editor.ApplyFailure('domains down')
        assert.equal(editor.IsEditable, false)
        assert.equal(editor.ErrorText, 'domains down')
        assert.equal(editor.ReadOnlyText, '')
    })
})
