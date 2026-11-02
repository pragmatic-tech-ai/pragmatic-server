import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Key } from '@pragmatic-tech-ai/mural/runtime'
import type { IFormPoster } from '../form-poster.js'
import { IdpLoginViewModel } from '../idp-login-view-model.js'
import { LoginBootState } from '../login-boot-state.js'

// Records each post's fields instead of navigating.
class FakePoster implements IFormPoster
{
    public readonly Posts: Array<Record<string, string>> = []

    public Post(fields: ReadonlyMap<string, string>): void
    {
        this.Posts.push(Object.fromEntries(fields))
    }
}

describe('IdP sign-in page', () =>
{
    it('a fresh page shows no error; a failed one says the credentials were wrong', () =>
    {
        assert.equal(new IdpLoginViewModel(new FakePoster(), false).ErrorText, '')
        assert.equal(new IdpLoginViewModel(new FakePoster(), true).ErrorText, 'Invalid email or password.')
    })

    it('Sign in is enabled only with an email and a password', () =>
    {
        const page = new IdpLoginViewModel(new FakePoster(), false)
        assert.equal(page.SignInCommand.CanExecute(), false)
        page.Email = '  '
        page.Password = 'pw'
        assert.equal(page.SignInCommand.CanExecute(), false)
        page.Email = 'a@b.test'
        assert.equal(page.SignInCommand.CanExecute(), true)
        page.Password = ''
        assert.equal(page.SignInCommand.CanExecute(), false)
    })

    it('Sign in posts the email (trimmed) and password as the IdP form fields, once, and keeps no password', () =>
    {
        const poster = new FakePoster()
        const page = new IdpLoginViewModel(poster, false)
        page.Email = ' a@b.test '
        page.Password = 'secret pw'
        page.SignInCommand.Execute()
        page.SignInCommand.Execute()
        assert.deepEqual(poster.Posts, [{ email: 'a@b.test', password: 'secret pw' }])
        assert.equal(page.Password, '')
        assert.equal(page.IsBusy, true)
        assert.equal(page.SignInCommand.CanExecute(), false)
    })

    it('Reset (a back/forward-cache restore) makes a posted form usable again, with no password', () =>
    {
        const poster = new FakePoster()
        const page = new IdpLoginViewModel(poster, false)
        page.Email = 'a@b.test'
        page.Password = 'pw'
        page.SignInCommand.Execute()
        assert.equal(page.SignInCommand.CanExecute(), false)
        page.Reset()
        assert.equal(page.IsBusy, false)
        assert.equal(page.Password, '')
        page.Password = 'pw2'
        assert.equal(page.SignInCommand.CanExecute(), true)
    })

    it('Return signs in and marks the key handled; other keys are left alone', () =>
    {
        const poster = new FakePoster()
        const page = new IdpLoginViewModel(poster, false)
        page.Email = 'a@b.test'
        page.Password = 'pw'
        const other = { Key: Key.Tab, Handled: false }
        page.SubmitKeyCommand.Execute(other)
        assert.equal(other.Handled, false)
        assert.equal(poster.Posts.length, 0)
        const enter = { Key: Key.Return, Handled: false }
        page.SubmitKeyCommand.Execute(enter)
        assert.equal(enter.Handled, true)
        assert.equal(poster.Posts.length, 1)
    })

    it('Return with an empty form posts nothing', () =>
    {
        const poster = new FakePoster()
        const page = new IdpLoginViewModel(poster, false)
        page.SubmitKeyCommand.Execute({ Key: Key.Return, Handled: false })
        assert.equal(poster.Posts.length, 0)
    })

    it('the boot state reads failed only from the exact flag', () =>
    {
        assert.equal(LoginBootState.FromContent('failed').Failed, true)
        assert.equal(LoginBootState.FromContent('ready').Failed, false)
        assert.equal(LoginBootState.FromContent(null).Failed, false)
        assert.equal(LoginBootState.FromContent('FAILED').Failed, false)
    })
})
