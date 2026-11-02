// Submits fields as a native HTML form POST, so the browser itself sends them
// and follows the response (the IdP's redirect back to the application, or the
// sign-in page again). Injected so tests capture the post without a DOM.
export interface IFormPoster
{
    Post(fields: ReadonlyMap<string, string>): void
}

// Posts to the page's own URL (its path and query: the IdP's authorize
// endpoint with the OIDC request parameters) through a transient hidden form.
export class BrowserFormPoster implements IFormPoster
{
    private static readonly FormTag = 'form'
    private static readonly InputTag = 'input'
    private static readonly PostMethod = 'post'
    private static readonly HiddenType = 'hidden'

    public Post(fields: ReadonlyMap<string, string>): void
    {
        const form = document.createElement(BrowserFormPoster.FormTag)
        form.method = BrowserFormPoster.PostMethod
        form.action = window.location.pathname + window.location.search
        for (const [name, value] of fields)
        {
            const input = document.createElement(BrowserFormPoster.InputTag)
            input.type = BrowserFormPoster.HiddenType
            input.name = name
            input.value = value
            form.appendChild(input)
        }
        document.body.appendChild(form)
        form.submit()
    }
}
