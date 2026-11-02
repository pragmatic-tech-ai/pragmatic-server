import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Key } from '@pragmatic-tech-ai/mural/runtime'
import { ApiError, type ControlPlaneClient } from '../../api-client.js'
import { LoginPageViewModel } from '../login-page-view-model.js'
import { FakeReloader, Tick } from './portal-test-fixtures.js'

// A client whose Login resolves, or rejects with the given error.
class FakeLoginClient
{
    public Calls = 0
    public LastEmail = ''

    public constructor(private readonly failure?: Error)
    {
    }

    public async Login(email: string, _password: string): Promise<void>
    {
        this.Calls++
        this.LastEmail = email
        if (this.failure !== undefined)
        {
            throw this.failure
        }
    }

    public AsClient(): ControlPlaneClient
    {
        return this as unknown as ControlPlaneClient
    }
}

class LoginFixture
{
    public static readonly Email = 'op@example.test'
    public static readonly Secret = 'not-a-real-secret'
    public static readonly Failure = 'Invalid email or password'

    public readonly Reloader = new FakeReloader()
    public readonly Client: FakeLoginClient
    public readonly Page: LoginPageViewModel

    public constructor(failure?: Error)
    {
        this.Client = new FakeLoginClient(failure)
        this.Page = new LoginPageViewModel(this.Client.AsClient(), this.Reloader)
    }

    public Fill(): void
    {
        this.Page.Email = LoginFixture.Email
        this.Page.Password = LoginFixture.Secret
    }
}

describe('LoginPageViewModel', () =>
{
    it('a successful login reloads the page once', async () =>
    {
        const f = new LoginFixture()
        f.Fill()
        f.Page.LoginCommand.Execute()
        await Tick.Next()
        assert.equal(f.Client.Calls, 1)
        assert.equal(f.Client.LastEmail, LoginFixture.Email)
        assert.equal(f.Reloader.Count, 1)
        assert.equal(f.Page.ErrorText, '')
    })

    it('a failed login shows the error, clears the password and does not reload', async () =>
    {
        const f = new LoginFixture(new ApiError(ApiError.UnauthorizedStatus, LoginFixture.Failure))
        f.Fill()
        f.Page.LoginCommand.Execute()
        await Tick.Next()
        assert.equal(f.Page.ErrorText, LoginFixture.Failure)
        assert.equal(f.Page.Password, '')
        assert.equal(f.Page.Email, LoginFixture.Email)
        assert.equal(f.Reloader.Count, 0)
        assert.equal(f.Page.IsBusy, false)
    })

    it('LoginCommand is disabled while email or password is empty', () =>
    {
        const f = new LoginFixture()
        assert.equal(f.Page.LoginCommand.CanExecute(), false)
        f.Page.Email = LoginFixture.Email
        assert.equal(f.Page.LoginCommand.CanExecute(), false)
        f.Page.Password = LoginFixture.Secret
        assert.equal(f.Page.LoginCommand.CanExecute(), true)
        f.Page.Email = ''
        assert.equal(f.Page.LoginCommand.CanExecute(), false)
    })

    it('LoginCommand is disabled while a login is in flight', async () =>
    {
        const f = new LoginFixture()
        f.Fill()
        let changes = 0
        f.Page.LoginCommand.AddCanExecuteChangedListener(() => { changes++ })
        f.Page.LoginCommand.Execute()
        assert.equal(f.Page.IsBusy, true)
        assert.equal(f.Page.LoginCommand.CanExecute(), false)
        assert.ok(changes > 0)
        await Tick.Next()
        assert.equal(f.Client.Calls, 1)
    })

    it('Return through SubmitKeyCommand logs in and marks the key handled', async () =>
    {
        const f = new LoginFixture()
        f.Fill()
        const args = { Key: Key.Return, Handled: false }
        f.Page.SubmitKeyCommand.Execute(args)
        await Tick.Next()
        assert.equal(args.Handled, true)
        assert.equal(f.Client.Calls, 1)
        assert.equal(f.Reloader.Count, 1)
    })

    it('other keys through SubmitKeyCommand do nothing', async () =>
    {
        const f = new LoginFixture()
        f.Fill()
        const args = { Key: Key.A, Handled: false }
        f.Page.SubmitKeyCommand.Execute(args)
        await Tick.Next()
        assert.equal(args.Handled, false)
        assert.equal(f.Client.Calls, 0)
    })

    it('Return with an empty password does not log in', async () =>
    {
        const f = new LoginFixture()
        f.Page.Email = LoginFixture.Email
        f.Page.SubmitKeyCommand.Execute({ Key: Key.Return, Handled: false })
        await Tick.Next()
        assert.equal(f.Client.Calls, 0)
    })

    it('ShowError sets ErrorText', () =>
    {
        const f = new LoginFixture()
        f.Page.ShowError(LoginFixture.Failure)
        assert.equal(f.Page.ErrorText, LoginFixture.Failure)
    })
})
