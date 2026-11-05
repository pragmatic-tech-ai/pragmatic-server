/** The few browser-page calls a sign-in needs (a Playwright Page satisfies it), so the smokes share one sign-in. */
export interface IIdpLoginBrowserPage
{
    waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>
    fill(selector: string, value: string): Promise<void>
    press(selector: string, key: string): Promise<void>
}

/**
 * The IdP's login page as the live smokes drive it. The page is the Mural idp-login app with native inputs: its fields are found
 * by their autocomplete tokens (as idp-login/tests/login.spec.ts does) and it has no form button, so Enter submits.
 */
export class IdpLoginPage
{
    public static readonly EmailSelector = 'input[autocomplete="email"]'
    public static readonly PasswordSelector = 'input[autocomplete="current-password"]'
    public static readonly SubmitKey = 'Enter'

    /** Resolves once the login form shows (the browser was redirected to the IdP). */
    public static async WaitForForm(page: IIdpLoginBrowserPage, timeoutMs: number): Promise<void>
    {
        await page.waitForSelector(IdpLoginPage.EmailSelector, { timeout: timeoutMs })
    }

    /** Types the credentials and submits; the password goes only into the field. */
    public static async Submit(page: IIdpLoginBrowserPage, email: string, password: string): Promise<void>
    {
        await page.fill(IdpLoginPage.EmailSelector, email)
        await page.fill(IdpLoginPage.PasswordSelector, password)
        await page.press(IdpLoginPage.PasswordSelector, IdpLoginPage.SubmitKey)
    }
}
