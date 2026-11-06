import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ToVisibility, Visibility } from '@pragmatic-tech-ai/mural/runtime'
import { TenantApiError } from '../../../tenant-api-client.js'
import { FakeTenantApi, TenantTestHost } from '../../../shell/tests/tenant-test-fixtures.js'
import { DomainApprovalState, type DomainVerificationDto } from '../../../tenant-types.js'
import { EmailDomainsEditorViewModel } from '../email-domains-editor-view-model.js'

const ApprovalSentence = 'A domain takes effect once the platform operator approves it, or once its DNS TXT record is verified and no other tenant claims it.'
const NoRecordNotice = 'No matching TXT record was found yet. DNS changes can take a while to appear; try again later.'
const Token = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'

class Fixture
{
    public static Verification(domain: string, state: DomainApprovalState, verified: boolean, lastCheckedAt?: string): DomainVerificationDto
    {
        const v: DomainVerificationDto = {
            domain, token: Token, verified, state,
            recordName: '_pragmatic-verification.' + domain, recordValue: 'pragmatic-domain-verification=' + Token,
        }
        if (lastCheckedAt !== undefined)
        {
            v.lastCheckedAt = lastCheckedAt
        }
        return v
    }

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
        assert.equal(editor.ApprovalText, ApprovalSentence)
        editor.ApplyUnavailable()
        assert.equal(editor.IsInHive, false)
        assert.equal(editor.ApprovalText, '')
    })

    it('a control-plane tenant names the domains still waiting for the operator\'s approval', async () =>
    {
        const api = new FakeTenantApi()
        api.EmailDomains = { domains: ['acme.test', 'beta.test', 'gamma.test'], editable: true, inHive: false, pending: ['beta.test', 'gamma.test'] }
        const editor = await Fixture.Loaded(api)
        assert.equal(editor.ApprovalText, 'Not in effect yet: beta.test, gamma.test. ' + ApprovalSentence)
        editor.DomainsText = 'acme.test, beta.test, gamma.test, delta.test'
        await editor.Save()
        assert.equal(editor.ApprovalText, 'Not in effect yet: beta.test, delta.test, gamma.test. ' + ApprovalSentence)
        editor.ApplyFailure('The tenant records are unavailable.')
        assert.equal(editor.ApprovalText, '')
    })

    it('Apply builds one verification row per verification with its record and labels', async () =>
    {
        const api = new FakeTenantApi()
        api.EmailDomains = {
            domains: ['acme.test', 'beta.test'], editable: true, inHive: false, pending: ['beta.test'],
            verifications: [
                Fixture.Verification('acme.test', DomainApprovalState.Verified, true, '2026-11-06T09:30:12.000Z'),
                Fixture.Verification('beta.test', DomainApprovalState.Pending, false),
            ],
        }
        const editor = await Fixture.Loaded(api)
        assert.equal(editor.HasVerifications, true)
        const rows = editor.Verifications.ToArray()
        assert.deepEqual(rows.map(r => [r.Domain, r.StatusLabel, r.VerificationLabel, r.RecordName, r.RecordValue, r.LastCheckedText]), [
            ['acme.test', 'Verified', 'Verified', '_pragmatic-verification.acme.test', 'pragmatic-domain-verification=' + Token, 'Last checked 2026-11-06 09:30 UTC'],
            ['beta.test', 'Pending', 'Not verified', '_pragmatic-verification.beta.test', 'pragmatic-domain-verification=' + Token, 'Not checked yet'],
        ])
    })

    it('the five states read as their labels', async () =>
    {
        const api = new FakeTenantApi()
        const states = [DomainApprovalState.Approved, DomainApprovalState.Verified, DomainApprovalState.VerifiedContested, DomainApprovalState.Revoked, DomainApprovalState.Pending]
        api.EmailDomains = {
            domains: states.map((_, i) => 'd' + i + '.test'), editable: true, inHive: false, pending: [],
            verifications: states.map((s, i) => Fixture.Verification('d' + i + '.test', s, false)),
        }
        const editor = await Fixture.Loaded(api)
        assert.deepEqual(editor.Verifications.ToArray().map(r => r.StatusLabel),
            ['Approved', 'Verified', 'Verified, contested - needs approval', 'Revoked', 'Pending'])
    })

    it('a dto without verifications shows no rows', async () =>
    {
        const editor = await Fixture.Loaded(new FakeTenantApi())
        assert.equal(editor.HasVerifications, false)
        assert.equal(editor.Verifications.Count, 0)
    })

    it('LastCheckedText formats 2026-11-06T09:30:12.000Z as \'Last checked 2026-11-06 09:30 UTC\'', async () =>
    {
        const api = new FakeTenantApi()
        api.EmailDomains = {
            domains: ['acme.test'], editable: true, inHive: false, pending: [],
            verifications: [Fixture.Verification('acme.test', DomainApprovalState.Verified, true, '2026-11-06T09:30:12.000Z')],
        }
        const editor = await Fixture.Loaded(api)
        assert.equal(editor.Verifications.ToArray()[0]!.LastCheckedText, 'Last checked 2026-11-06 09:30 UTC')
    })

    it('the Owner can Verify; a non-Owner gets no Verify', async () =>
    {
        const api = new FakeTenantApi()
        api.EmailDomains = {
            domains: ['acme.test'], editable: false, inHive: true, pending: [],
            verifications: [Fixture.Verification('acme.test', DomainApprovalState.Pending, false)],
        }
        const owner = await Fixture.Loaded(api, true)
        assert.equal(owner.IsEditable, false)
        const ownerRow = owner.Verifications.ToArray()[0]!
        assert.equal(ownerRow.CanVerify, true)
        assert.equal(ownerRow.VerifyCommand.CanExecute(undefined), true)
        const other = await Fixture.Loaded(api, false)
        const otherRow = other.Verifications.ToArray()[0]!
        assert.equal(otherRow.CanVerify, false)
        assert.equal(otherRow.VerifyCommand.CanExecute(undefined), false)
    })

    it('VerifyDomain calls the client and rebuilds the rows', async () =>
    {
        const api = new FakeTenantApi()
        api.EmailDomains = {
            domains: ['acme.test'], editable: true, inHive: false, pending: ['acme.test'],
            verifications: [Fixture.Verification('acme.test', DomainApprovalState.Pending, false)],
        }
        const editor = await Fixture.Loaded(api)
        api.OnVerifyEmailDomain = () =>
        {
            api.EmailDomains = {
                domains: ['acme.test'], editable: true, inHive: false, pending: [],
                verifications: [Fixture.Verification('acme.test', DomainApprovalState.Verified, true, '2026-11-06T09:30:12.000Z')],
            }
        }
        await editor.VerifyDomain('acme.test')
        assert.deepEqual(api.Calls, [['VerifyEmailDomain', 'acme.test']])
        const row = editor.Verifications.ToArray()[0]!
        assert.equal(row.StatusLabel, 'Verified')
        assert.equal(row.VerificationLabel, 'Verified')
        assert.equal(editor.VerifyNoticeText, '')
        assert.equal(editor.ErrorText, '')
        assert.equal(editor.IsVerifying, false)
        assert.equal(editor.ApprovalText, '')
    })

    it('a verify that leaves the row Not verified shows the notice, cleared by the next action', async () =>
    {
        const api = new FakeTenantApi()
        api.EmailDomains = {
            domains: ['acme.test'], editable: true, inHive: false, pending: ['acme.test'],
            verifications: [Fixture.Verification('acme.test', DomainApprovalState.Pending, false)],
        }
        const editor = await Fixture.Loaded(api)
        await editor.VerifyDomain('acme.test')
        assert.equal(editor.VerifyNoticeText, NoRecordNotice)
        api.OnVerifyEmailDomain = () => { api.EmailDomains = { ...api.EmailDomains, verifications: [Fixture.Verification('acme.test', DomainApprovalState.Verified, true)] } }
        await editor.VerifyDomain('acme.test')
        assert.equal(editor.VerifyNoticeText, '')
    })

    it('a save keeps the verification rows of the domains that survive', async () =>
    {
        const api = new FakeTenantApi()
        api.EmailDomains = {
            domains: ['acme.test', 'beta.test'], editable: true, inHive: false, pending: [],
            verifications: [
                Fixture.Verification('acme.test', DomainApprovalState.Verified, true),
                Fixture.Verification('beta.test', DomainApprovalState.Pending, false),
            ],
        }
        const editor = await Fixture.Loaded(api)
        editor.DomainsText = 'acme.test'
        await editor.Save()
        assert.deepEqual(editor.Verifications.ToArray().map(r => r.Domain), ['acme.test'])
        assert.equal(editor.Verifications.ToArray()[0]!.StatusLabel, 'Verified')
    })

    it('a refusal shows its sentence; a 401 expires the session', async () =>
    {
        const api = new FakeTenantApi()
        const host = new TenantTestHost(api)
        const editor = Fixture.Editor(api, host)
        api.EmailDomains = {
            domains: ['acme.test'], editable: true, inHive: false, pending: [],
            verifications: [Fixture.Verification('acme.test', DomainApprovalState.Pending, false)],
        }
        editor.Apply(await api.GetEmailDomains(), true)
        api.FailOn.set('VerifyEmailDomain', new TenantApiError(429, 'Too many lookups for this tenant; try again later.'))
        await editor.VerifyDomain('acme.test')
        assert.equal(editor.ErrorText, 'Too many lookups for this tenant; try again later.')
        assert.equal(editor.VerifyNoticeText, '')
        assert.equal(editor.IsVerifying, false)
        api.FailOn.set('VerifyEmailDomain', new TenantApiError(401, 'gone'))
        await editor.VerifyDomain('acme.test')
        assert.equal(host.Reloader.Count, 1)
        assert.equal(editor.ErrorText, '')
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
