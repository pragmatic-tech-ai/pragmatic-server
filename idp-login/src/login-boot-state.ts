// What the IdP told the page when it served it: a `<meta name="pragmatic-login">`
// whose content is "failed" after a rejected sign-in and "ready" otherwise.
export class LoginBootState
{
    public static readonly MetaSelector = 'meta[name="pragmatic-login"]'
    public static readonly FailedValue = 'failed'
    private static readonly ContentAttribute = 'content'

    private constructor(public readonly Failed: boolean)
    {
    }

    // The state carried by a meta tag's content; anything but "failed" reads as a fresh page.
    public static FromContent(content: string | null | undefined): LoginBootState
    {
        return new LoginBootState(content === LoginBootState.FailedValue)
    }

    public static FromDocument(doc: Document): LoginBootState
    {
        return LoginBootState.FromContent(doc.querySelector(LoginBootState.MetaSelector)?.getAttribute(LoginBootState.ContentAttribute))
    }
}
