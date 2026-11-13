import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { IdpLoginPage } from '../idp-login-page.js'
import type { ApiAnswer } from './operator-api-client.js'
import { OperatorApiClient } from './operator-api-client.js'

/**
 * The tenant owner signed in to the platform's tenant plane, as a person would: a headless Chromium opens the tenant origin,
 * the portal redirects to the tenant's IdP login form, the owner signs in and lands back with a `pts_session`. Tenant API calls
 * then run as same-origin fetches inside that page, so the session cookie and the Origin check behave exactly as in the
 * portal. The password is typed into the form only: never logged, printed or put in an error.
 */
export class TenantOwnerSession
{
    private static readonly RootPath = '/'
    private static readonly SessionCookieName = 'pts_session'
    private static readonly FormWaitMs = 60_000
    private static readonly ReturnWaitMs = 60_000
    private static readonly SettledState = 'networkidle'
    private static readonly PasswordPath = '/tenant-auth/password'
    private static readonly MethodPost = 'POST'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly JsonType = 'application/json'
    private static readonly StatusOk = 200
    private static readonly NoSessionMessage = 'tenant owner sign-in did not end with a session on the tenant plane'
    private static readonly PasswordChangeFailedPrefix = 'owner password change failed: status '

    private constructor(private readonly browser: Browser, private readonly page: Page)
    {
    }

    /** Signs the owner in at `tenantOrigin` (e.g. http://e2e.lvh.me:7100); the IdP's development certificate is accepted. */
    public static async Open(tenantOrigin: string, email: string, password: string): Promise<TenantOwnerSession>
    {
        const S = TenantOwnerSession
        const browser = await chromium.launch()
        try
        {
            const context = await browser.newContext({ ignoreHTTPSErrors: true })
            const page = await context.newPage()
            const tenantHost = new URL(tenantOrigin).host
            await page.goto(tenantOrigin + S.RootPath)
            await IdpLoginPage.WaitForForm(page, S.FormWaitMs)
            await IdpLoginPage.Submit(page, email, password)
            await page.waitForURL(url => url.host === tenantHost, { timeout: S.ReturnWaitMs })
            // The portal keeps loading after the redirect lands; a fetch issued mid-navigation fails, so wait for it to settle.
            await page.waitForLoadState(S.SettledState, { timeout: S.ReturnWaitMs })
            const cookies = await context.cookies()
            if (!cookies.some(c => c.name === S.SessionCookieName && c.value.length > 0))
            {
                throw new Error(S.NoSessionMessage)
            }
            return new TenantOwnerSession(browser, page)
        }
        catch (err)
        {
            await browser.close()
            throw err
        }
    }

    /** One same-origin call from the signed-in page (the portal's own cookie and Origin). */
    public async Call(method: string, path: string, body?: unknown): Promise<ApiAnswer>
    {
        const answer = await this.page.evaluate(async ({ method, path, body, contentType, jsonType }) =>
        {
            const init: RequestInit = { method }
            if (body !== undefined)
            {
                init.body = body
                init.headers = { [contentType]: jsonType }
            }
            const r = await fetch(path, init)
            return { status: r.status, text: await r.text() }
        }, { method, path, body: body === undefined ? undefined : JSON.stringify(body), contentType: TenantOwnerSession.ContentTypeHeader, jsonType: TenantOwnerSession.JsonType })
        return { status: answer.status, body: OperatorApiClient.ParseObject(answer.text) }
    }

    /** Changes the owner's password through the tenant plane (its policy: at least 12 characters). */
    public async ChangePassword(current: string, next: string): Promise<void>
    {
        const S = TenantOwnerSession
        const answer = await this.Call(S.MethodPost, S.PasswordPath, { currentPassword: current, newPassword: next, confirmPassword: next })
        if (answer.status !== S.StatusOk)
        {
            throw new Error(S.PasswordChangeFailedPrefix + String(answer.status))
        }
    }

    public async Close(): Promise<void>
    {
        await this.browser.close()
    }
}
