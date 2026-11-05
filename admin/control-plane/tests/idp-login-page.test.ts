import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IdpLoginPage, type IIdpLoginBrowserPage } from '../idp-login-page.js'

class RecordingPage implements IIdpLoginBrowserPage
{
    public readonly Calls: string[][] = []

    public async waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>
    {
        this.Calls.push(['waitForSelector', selector, String(options.timeout)])
        return undefined
    }

    public async fill(selector: string, value: string): Promise<void>
    {
        this.Calls.push(['fill', selector, value])
    }

    public async press(selector: string, key: string): Promise<void>
    {
        this.Calls.push(['press', selector, key])
    }
}

class SmokeSources
{
    public static readonly Files = ['in-hive-console-smoke.ts', 'in-cluster-federation-smoke.ts', 'tenant-login-e2e-smoke.ts']

    public static Text(file: string): string
    {
        return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', file), 'utf8')
    }
}

describe('IdpLoginPage', () =>
{
    it('targets the Mural IdP login by autocomplete token and submits with Enter (it has no form button)', () =>
    {
        assert.equal(IdpLoginPage.EmailSelector, 'input[autocomplete="email"]')
        assert.equal(IdpLoginPage.PasswordSelector, 'input[autocomplete="current-password"]')
        assert.equal(IdpLoginPage.SubmitKey, 'Enter')
    })

    it('WaitForForm waits for the email field; Submit fills email and password, then presses Enter on the password', async () =>
    {
        const page = new RecordingPage()
        await IdpLoginPage.WaitForForm(page, 5000)
        await IdpLoginPage.Submit(page, 'owner@acme.test', 'pw')
        assert.deepEqual(page.Calls, [
            ['waitForSelector', IdpLoginPage.EmailSelector, '5000'],
            ['fill', IdpLoginPage.EmailSelector, 'owner@acme.test'],
            ['fill', IdpLoginPage.PasswordSelector, 'pw'],
            ['press', IdpLoginPage.PasswordSelector, 'Enter'],
        ])
    })

    it('every IdP-login smoke signs in through IdpLoginPage, never the retired name= / submit-button selectors', () =>
    {
        for (const file of SmokeSources.Files)
        {
            const text = SmokeSources.Text(file)
            assert.ok(text.includes('IdpLoginPage.WaitForForm(') && text.includes('IdpLoginPage.Submit('), file)
            assert.ok(!text.includes('input[name=') && !text.includes('button[type=submit]'), file)
        }
    })
})
