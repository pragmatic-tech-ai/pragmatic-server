// Where the sign-in page was served and for what: the realm issuer's path
// (the page's path without the authorize suffix), the OIDC authorize request
// (the page's query without its `?`), and the two parameters the page itself
// reads from that request: `prompt=create` (open in sign-up mode) and
// `login_hint` (prefill the email).
export class LoginPageLocation
{
    public static readonly AuthorizeSuffix = '/protocol/openid-connect/auth'
    // Where a federated provider returns the browser: the page again, served without validating the request (the
    // provider's own parameters would otherwise be read as the authorize request's).
    public static readonly ContinueSuffix = '/login/continue'
    private static readonly LoginSuffix = '/login'
    private static readonly ConfigSuffix = '/login/config'
    private static readonly QueryMark = '?'
    private static readonly PromptParam = 'prompt'
    private static readonly PromptCreate = 'create'
    private static readonly PromptSeparator = ' '
    private static readonly LoginHintParam = 'login_hint'
    private static readonly NoText = ''

    private constructor(
        public readonly Origin: string,
        public readonly IssuerPath: string,
        public readonly Request: string,
        /** The page's full URL as the browser shows it (what a federated provider answered to). */
        public readonly Href: string)
    {
    }

    // The location of a page served at `origin` + `pathname` + `search`.
    public static From(origin: string, pathname: string, search: string): LoginPageLocation
    {
        const L = LoginPageLocation
        const suffix = [L.AuthorizeSuffix, L.ContinueSuffix].find(candidate => pathname.endsWith(candidate))
        const issuer = suffix === undefined ? pathname : pathname.slice(0, pathname.length - suffix.length)
        const request = search.startsWith(L.QueryMark) ? search.slice(1) : search
        return new LoginPageLocation(origin, issuer, request, origin + pathname + search)
    }

    public static FromWindow(): LoginPageLocation
    {
        return LoginPageLocation.From(window.location.origin, window.location.pathname, window.location.search)
    }

    // The same page for another authorize request (the original one, restored after a round trip).
    public WithRequest(request: string): LoginPageLocation
    {
        return new LoginPageLocation(this.Origin, this.IssuerPath, request, this.Href)
    }

    // The page's own query, as `location.search` reports it.
    public get Search(): string
    {
        return this.Request === LoginPageLocation.NoText ? LoginPageLocation.NoText : LoginPageLocation.QueryMark + this.Request
    }

    // `GET` here answers what the realm's page offers.
    public get ConfigPath(): string
    {
        return this.IssuerPath + LoginPageLocation.ConfigSuffix
    }

    // `POST` (JSON) here signs in.
    public get LoginPath(): string
    {
        return this.IssuerPath + LoginPageLocation.LoginSuffix
    }

    // The absolute authorize URL with this request: the page itself.
    public get AuthorizeUrl(): string
    {
        return this.Origin + this.IssuerPath + LoginPageLocation.AuthorizeSuffix + this.Search
    }

    // Where a federated provider sends the browser back (the page, never the authorize endpoint).
    public get ContinueUrl(): string
    {
        return this.Origin + this.IssuerPath + LoginPageLocation.ContinueSuffix
    }

    // True when the request carries `prompt=create` (OpenID Connect Initiating User Registration).
    public get PromptsCreate(): boolean
    {
        const prompt = this.Params().get(LoginPageLocation.PromptParam) ?? LoginPageLocation.NoText
        return prompt.split(LoginPageLocation.PromptSeparator).includes(LoginPageLocation.PromptCreate)
    }

    // The request's `login_hint`, or '' without one.
    public get LoginHint(): string
    {
        return this.Params().get(LoginPageLocation.LoginHintParam) ?? LoginPageLocation.NoText
    }

    private Params(): URLSearchParams
    {
        return new URLSearchParams(this.Request)
    }
}
