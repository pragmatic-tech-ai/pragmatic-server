import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Key } from '@pragmatic-tech-ai/mural/runtime'
import { IdentityPlatformProvider } from '@pragmatic-tech-ai/pragmatic-identity-source-identity-platform/client'
import { FederatedRoundTrip, PendingFederatedSignIn } from '../federated-round-trip.js'
import { LoginMode } from '../idp-login-view-model.js'
import { LoginAnswer } from '../login-backend.js'
import { LoginSource } from '../login-config.js'
import { FakeBackend, LoginFixture, MemoryStorage } from './login-fakes.js'

const Password = IdentityPlatformProvider.Password
const Google = IdentityPlatformProvider.Google

describe('IdP sign-in page: local accounts', () =>
{
    it('loads the config; a fresh page shows no error, a page served flagged says the credentials were wrong', async () =>
    {
        const fresh = await LoginFixture.Loaded(LoginFixture.Local())
        assert.equal(fresh.Backend.Loads, 1)
        assert.equal(fresh.Page.IsLoading, false)
        assert.equal(fresh.Page.ErrorText, '')
        assert.equal(fresh.Page.ShowsPasswordForm, true)
        assert.equal(fresh.Page.ShowsForgotLink, false)
        assert.equal(fresh.Page.ShowsCreateAccountLink, false)
        assert.equal(fresh.Page.ShowsGoogle, false)
        const failed = new LoginFixture(LoginFixture.Local(), undefined, undefined, true)
        assert.equal(failed.Page.ErrorText, 'Invalid email or password.')
    })

    it('a config that cannot load says so and offers no form', async () =>
    {
        const page = (await LoginFixture.Loaded(undefined)).Page
        assert.equal(page.IsLoading, false)
        assert.equal(page.ShowsPasswordForm, false)
        assert.equal(page.ErrorText, 'The sign-in page could not load. Please reload it.')
    })

    it('Sign in is enabled only with an email and a password', async () =>
    {
        const page = (await LoginFixture.Loaded(LoginFixture.Local())).Page
        assert.equal(page.SignInCommand.CanExecute(), false)
        page.Email = '  '
        page.Password = 'pw'
        assert.equal(page.SignInCommand.CanExecute(), false)
        page.Email = 'a@b.test'
        assert.equal(page.SignInCommand.CanExecute(), true)
        page.Password = ''
        assert.equal(page.SignInCommand.CanExecute(), false)
    })

    it('Sign in posts the request, method password, the trimmed email and the password as JSON once, keeps no password and follows the redirect', async () =>
    {
        const fixture = await LoginFixture.Loaded(LoginFixture.Local())
        const page = fixture.Page
        page.Email = ' a@b.test '
        page.Password = 'secret pw'
        page.SignInCommand.Execute()
        page.SignInCommand.Execute()
        assert.equal(page.Password, '')
        assert.equal(page.IsBusy, true)
        await LoginFixture.Settle()
        assert.deepEqual(fixture.Backend.Posts, [{ request: LoginFixture.Request, method: 'password', email: 'a@b.test', password: 'secret pw' }])
        assert.deepEqual(fixture.Navigator.Visits, [FakeBackend.DoneUrl])
        assert.equal(page.IsBusy, true)
        assert.equal(page.SignInCommand.CanExecute(), false)
    })

    it('a refusal shows why and makes the form usable again', async () =>
    {
        const fixture = await LoginFixture.Loaded(LoginFixture.Local())
        const page = fixture.Page
        const cases: Array<[LoginAnswer, string]> = [
            [LoginAnswer.Refused('invalid_credentials'), 'Invalid email or password.'],
            [LoginAnswer.Refused('too_many_attempts', undefined, 30), 'Too many attempts. Try again in 30 seconds.'],
            [LoginAnswer.Refused('too_many_attempts'), 'Too many attempts. Try again later.'],
            [LoginAnswer.Refused('invalid_request', 'unknown client'), 'unknown client'],
            [LoginAnswer.Refused('invalid_request'), 'This sign-in link is no longer valid. Return to the application and sign in again.'],
            [LoginAnswer.Refused(LoginAnswer.Unavailable), 'Sign-in is unavailable right now. Please try again.'],
        ]
        for (const [answer, message] of cases)
        {
            fixture.Backend.Answers.push(answer)
            page.Email = 'a@b.test'
            page.Password = 'pw'
            await page.SignIn()
            assert.equal(page.ErrorText, message)
            assert.equal(page.IsBusy, false)
            assert.equal(page.Password, '')
        }
        assert.equal(fixture.Navigator.Visits.length, 0)
    })

    it('Reset (a back/forward-cache restore) makes a posted form usable again, with no password', async () =>
    {
        const page = (await LoginFixture.Loaded(LoginFixture.Local())).Page
        page.Email = 'a@b.test'
        page.Password = 'pw'
        await page.SignIn()
        assert.equal(page.SignInCommand.CanExecute(), false)
        page.Reset()
        assert.equal(page.IsBusy, false)
        assert.equal(page.Password, '')
        page.Password = 'pw2'
        assert.equal(page.SignInCommand.CanExecute(), true)
    })

    it('Return signs in and marks the key handled; other keys and an empty form are left alone', async () =>
    {
        const fixture = await LoginFixture.Loaded(LoginFixture.Local())
        const page = fixture.Page
        const empty = { Key: Key.Return, Handled: false }
        page.SubmitKeyCommand.Execute(empty)
        assert.equal(empty.Handled, false)
        page.Email = 'a@b.test'
        page.Password = 'pw'
        const other = { Key: Key.Tab, Handled: false }
        page.SubmitKeyCommand.Execute(other)
        assert.equal(other.Handled, false)
        await LoginFixture.Settle()
        assert.equal(fixture.Backend.Posts.length, 0)
        const enter = { Key: Key.Return, Handled: false }
        page.SubmitKeyCommand.Execute(enter)
        assert.equal(enter.Handled, true)
        await LoginFixture.Settle()
        assert.equal(fixture.Backend.Posts.length, 1)
    })

    it('one button per upstream source navigates to its broker login with the authorize request appended', async () =>
    {
        const sources = [
            new LoginSource('google', 'google', 'Google', '/realms/central/broker/google/login?'),
            new LoginSource('entra', 'microsoft', 'Microsoft', '/realms/central/broker/entra/login?'),
        ]
        const fixture = await LoginFixture.Loaded(LoginFixture.Local(sources))
        const page = fixture.Page
        assert.equal(page.ShowsSources, true)
        assert.equal(page.ShowsDivider, true)
        assert.deepEqual(page.Sources.ToArray().map(source => source.Label), ['Google', 'Microsoft'])
        page.Sources.ToArray()[1]!.SignInCommand.Execute()
        assert.deepEqual(fixture.Navigator.Visits, ['/realms/central/broker/entra/login?' + LoginFixture.Request])
    })

    it('login_hint prefills the email', async () =>
    {
        const page = (await LoginFixture.Loaded(LoginFixture.Local(), LoginFixture.Request + '&login_hint=hint%40b.test')).Page
        assert.equal(page.Email, 'hint@b.test')
    })

    it('a realm with nothing enabled says so', async () =>
    {
        const config = LoginFixture.Platform([])
        const page = (await LoginFixture.Loaded(config)).Page
        assert.equal(page.ErrorText, 'No sign-in method is configured for this realm.')
    })
})

describe('IdP sign-in page: Identity Platform', () =>
{
    it('signs in with the password through Identity Platform and posts its ID token', async () =>
    {
        const fixture = await LoginFixture.Loaded(LoginFixture.Platform([Password]))
        fixture.Ip.Ok('accounts:signInWithPassword', { localId: 'u1', email: 'a@b.test', idToken: 'tok-1' })
        const page = fixture.Page
        assert.equal(page.ShowsForgotLink, true)
        assert.equal(page.ShowsCreateAccountLink, true)
        page.Email = 'a@b.test'
        page.Password = 'pw'
        await page.SignIn()
        assert.deepEqual(fixture.Ip.Calls[0]!.body, { email: 'a@b.test', password: 'pw', returnSecureToken: true })
        assert.ok(fixture.Ip.Calls[0]!.url.includes('key=' + LoginFixture.ApiKey))
        assert.deepEqual(fixture.Backend.Posts, [{ request: LoginFixture.Request, method: 'identityPlatform', idToken: 'tok-1' }])
        assert.deepEqual(fixture.Navigator.Visits, [FakeBackend.DoneUrl])
    })

    it('Identity Platform rejecting the credentials shows the error; with local accounts too, the page tries those', async () =>
    {
        const only = await LoginFixture.Loaded(LoginFixture.Platform([Password]))
        only.Ip.Error('accounts:signInWithPassword', 'INVALID_LOGIN_CREDENTIALS')
        only.Page.Email = 'a@b.test'
        only.Page.Password = 'pw'
        await only.Page.SignIn()
        assert.equal(only.Page.ErrorText, 'Invalid email or password.')
        assert.equal(only.Backend.Posts.length, 0)

        const both = await LoginFixture.Loaded(LoginFixture.Platform([Password], false, true))
        both.Ip.Error('accounts:signInWithPassword', 'INVALID_LOGIN_CREDENTIALS')
        both.Page.Email = 'a@b.test'
        both.Page.Password = 'pw'
        await both.Page.SignIn()
        assert.deepEqual(both.Backend.Posts, [{ request: LoginFixture.Request, method: 'password', email: 'a@b.test', password: 'pw' }])
    })

    it('email_not_verified offers Resend, which sends the verification email with that sign-in\'s token', async () =>
    {
        const fixture = await LoginFixture.Loaded(LoginFixture.Platform([Password]))
        fixture.Ip.Ok('accounts:signInWithPassword', { localId: 'u1', idToken: 'tok-unverified' }).Ok('accounts:sendOobCode', {})
        fixture.Backend.Answers.push(LoginAnswer.Refused('email_not_verified'))
        const page = fixture.Page
        page.Email = 'a@b.test'
        page.Password = 'pw'
        await page.SignIn()
        assert.match(page.ErrorText, /^Verify your email address first/)
        assert.equal(page.ShowsResend, true)
        assert.equal(page.ResendVerificationCommand.CanExecute(), true)
        await page.ResendVerification()
        assert.deepEqual(fixture.Ip.Calls.at(-1)!.body, { requestType: 'VERIFY_EMAIL', idToken: 'tok-unverified' })
        assert.equal(page.ShowsResend, false)
        assert.equal(page.ErrorText, '')
        assert.equal(page.NoticeText, 'We sent a new verification email. Open its link, then sign in.')
    })

    it('sign-up creates the account, sends the verification email and returns to sign in', async () =>
    {
        const fixture = await LoginFixture.Loaded(LoginFixture.Platform([Password]))
        fixture.Ip.Ok('accounts:signUp', { localId: 'u2', idToken: 'tok-new' }).Ok('accounts:sendOobCode', {})
        const page = fixture.Page
        page.ShowSignUpCommand.Execute()
        assert.equal(page.Mode, LoginMode.SignUp)
        assert.equal(page.Title, 'Create an account')
        assert.equal(page.ShowsConfirm, true)
        assert.equal(page.ShowsCurrentPassword, false)
        page.Email = 'new@b.test'
        page.Password = 'pw-123456'
        assert.equal(page.SignUpCommand.CanExecute(), false)
        page.ConfirmPassword = 'pw-123456'
        assert.equal(page.SignUpCommand.CanExecute(), true)
        await page.SignUp()
        assert.deepEqual(fixture.Ip.Endpoints(), ['accounts:signUp', 'accounts:sendOobCode'])
        assert.deepEqual(fixture.Ip.Calls[1]!.body, { requestType: 'VERIFY_EMAIL', idToken: 'tok-new' })
        assert.equal(page.Mode, LoginMode.SignIn)
        assert.equal(page.NoticeText, 'Check your email, then sign in.')
        assert.equal(page.Password, '')
        assert.equal(page.ConfirmPassword, '')
        assert.equal(fixture.Backend.Posts.length, 0)
    })

    it('sign-up refuses mismatched passwords and shows Identity Platform\'s refusal', async () =>
    {
        const fixture = await LoginFixture.Loaded(LoginFixture.Platform([Password]))
        fixture.Ip.Error('accounts:signUp', 'EMAIL_EXISTS')
        const page = fixture.Page
        page.ShowSignUpCommand.Execute()
        page.Email = 'new@b.test'
        page.Password = 'one'
        page.ConfirmPassword = 'two'
        await page.SignUp()
        assert.equal(page.ErrorText, 'The passwords do not match.')
        assert.equal(fixture.Ip.Calls.length, 0)
        page.Password = 'same-pw'
        page.ConfirmPassword = 'same-pw'
        await page.SignUp()
        assert.equal(page.ErrorText, 'An account with this email already exists. Sign in instead.')
        assert.equal(page.Mode, LoginMode.SignUp)
    })

    it('prompt=create opens in sign-up mode when the realm offers sign-up, not otherwise', async () =>
    {
        const create = LoginFixture.Request + '&prompt=create'
        assert.equal((await LoginFixture.Loaded(LoginFixture.Platform([Password]), create)).Page.Mode, LoginMode.SignUp)
        assert.equal((await LoginFixture.Loaded(LoginFixture.Platform([Password], false), create)).Page.Mode, LoginMode.SignIn)
        assert.equal((await LoginFixture.Loaded(LoginFixture.Local(), create)).Page.Mode, LoginMode.SignIn)
    })

    it('forgot password sends the reset email and answers neutrally, even for an unknown email', async () =>
    {
        for (const reply of ['ok', 'EMAIL_NOT_FOUND'])
        {
            const fixture = await LoginFixture.Loaded(LoginFixture.Platform([Password]))
            if (reply === 'ok')
            {
                fixture.Ip.Ok('accounts:sendOobCode', {})
            }
            else
            {
                fixture.Ip.Error('accounts:sendOobCode', reply)
            }
            const page = fixture.Page
            page.ShowForgotCommand.Execute()
            assert.equal(page.IsForgotMode, true)
            assert.equal(page.ShowsResetButton, true)
            assert.equal(page.ShowsCurrentPassword, false)
            page.Email = 'who@b.test'
            await page.SendReset()
            assert.deepEqual(fixture.Ip.Calls[0]!.body, { requestType: 'PASSWORD_RESET', email: 'who@b.test' })
            assert.equal(page.NoticeText, 'If an account exists for that email, we sent it a link to reset the password.')
            assert.equal(page.ErrorText, '')
            assert.equal(page.Mode, LoginMode.SignIn)
        }
    })

    it('Continue with Google saves the round trip and leaves for Google, coming back to the page continue path', async () =>
    {
        const fixture = await LoginFixture.Loaded(LoginFixture.Platform([Google], false, false, 'tenant-a'))
        fixture.Ip.Ok('accounts:createAuthUri', { authUri: 'https://accounts.google.com/o/oauth2/auth?x=1', sessionId: 'sess-1' })
        const page = fixture.Page
        assert.equal(page.ShowsGoogle, true)
        assert.equal(page.ShowsPasswordForm, false)
        await page.SignInWithGoogle()
        assert.deepEqual(fixture.Ip.Calls[0]!.body, {
            providerId: 'google.com',
            continueUri: LoginFixture.Origin + LoginFixture.ContinuePath,
            tenantId: 'tenant-a',
        })
        assert.deepEqual(fixture.Navigator.Visits, ['https://accounts.google.com/o/oauth2/auth?x=1'])
        const pending = new FederatedRoundTrip(fixture.Storage).Take('different')
        assert.deepEqual(pending, new PendingFederatedSignIn('sess-1', LoginFixture.Request, '/realms/central'))
    })

    it('coming back from Google signs in with signInWithIdp and posts the ORIGINAL authorize request', async () =>
    {
        const storage = new MemoryStorage()
        new FederatedRoundTrip(storage).Save(new PendingFederatedSignIn('sess-1', LoginFixture.Request, '/realms/central'))
        const returned = LoginFixture.Request + '&state=g-state&code=g-code&scope=email'
        const fixture = new LoginFixture(LoginFixture.Platform([Google]), returned, storage)
        fixture.Ip.Ok('accounts:signInWithIdp', { localId: 'g-1', idToken: 'tok-google' })
        await fixture.Page.Load()
        assert.deepEqual(fixture.Ip.Calls[0]!.body, {
            requestUri: LoginFixture.Origin + LoginFixture.AuthorizePath + '?' + returned,
            sessionId: 'sess-1',
            returnSecureToken: true,
            returnIdpCredential: true,
        })
        assert.deepEqual(fixture.Backend.Posts, [{ request: LoginFixture.Request, method: 'identityPlatform', idToken: 'tok-google' }])
        assert.deepEqual(fixture.Navigator.Visits, [FakeBackend.DoneUrl])
        assert.equal(storage.Items.size, 0)
    })

    it('a failed Google return shows the error; the page then starts again from the original request', async () =>
    {
        const storage = new MemoryStorage()
        new FederatedRoundTrip(storage).Save(new PendingFederatedSignIn('sess-1', LoginFixture.Request, '/realms/central'))
        const fixture = new LoginFixture(LoginFixture.Platform([Google]), LoginFixture.Request + '&error=access_denied', storage)
        fixture.Ip.Error('accounts:signInWithIdp', 'INVALID_IDP_RESPONSE')
        fixture.Ip.Ok('accounts:createAuthUri', { authUri: 'https://accounts.google.com/again', sessionId: 'sess-2' })
        await fixture.Page.Load()
        assert.equal(fixture.Page.ErrorText, 'Signing in with Google did not complete. Please try again.')
        assert.equal(fixture.Backend.Posts.length, 0)
        await fixture.Page.SignInWithGoogle()
        assert.equal(fixture.Ip.Calls[1]!.body.continueUri, LoginFixture.Origin + LoginFixture.ContinuePath)
    })

    it('a plain reload with a saved round trip does not try to complete it', async () =>
    {
        const storage = new MemoryStorage()
        new FederatedRoundTrip(storage).Save(new PendingFederatedSignIn('sess-1', LoginFixture.Request, '/realms/central'))
        const fixture = new LoginFixture(LoginFixture.Platform([Google]), LoginFixture.Request, storage)
        await fixture.Page.Load()
        assert.equal(fixture.Ip.Calls.length, 0)
        assert.equal(storage.Items.size, 0)
    })
})
