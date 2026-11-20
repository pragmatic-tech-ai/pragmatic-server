import type { IdpRealm } from './idp-realm.js';
import type { OidcClient, SqlIdpClientStore } from './sql-idp-client-store.js';

/** A refused authorize request: the status and the OAuth error body (never redirected: the client is not trusted yet). */
export class AuthorizeRefusal
{
    private static readonly ErrorField = 'error';
    private static readonly DescriptionField = 'error_description';

    public constructor(public readonly Status: number, public readonly Error: string, public readonly Description: string)
    {
        Object.freeze(this);
    }

    public Body(): Record<string, string>
    {
        return { [AuthorizeRefusal.ErrorField]: this.Error, [AuthorizeRefusal.DescriptionField]: this.Description };
    }
}

/**
 * A validated OIDC authorize request (authorization code flow with PKCE S256, state and nonce required, the redirect
 * URI registered for the client), and the `prompt` values it carries: `none` (answer silently or not at all), `login`
 * (authenticate again even with a session), `create` (OpenID Connect Initiating User Registration: open on sign-up).
 * `Query` is the request as the browser sent it, so the login page and an upstream sign-in carry it unchanged.
 */
export class AuthorizeRequest
{
    public static readonly PromptNone = 'none';
    public static readonly PromptLogin = 'login';
    public static readonly PromptCreate = 'create';

    private static readonly ResponseTypeParam = 'response_type';
    private static readonly ResponseTypeCode = 'code';
    private static readonly ClientIdParam = 'client_id';
    private static readonly RedirectUriParam = 'redirect_uri';
    private static readonly CodeChallengeParam = 'code_challenge';
    private static readonly CodeChallengeMethodParam = 'code_challenge_method';
    private static readonly MethodS256 = 'S256';
    private static readonly StateParam = 'state';
    private static readonly NonceParam = 'nonce';
    private static readonly PromptParam = 'prompt';
    private static readonly LoginHintParam = 'login_hint';
    private static readonly PromptSeparator = ' ';
    private static readonly NoValue = '';
    private static readonly MaxQueryChars = 4096;
    private static readonly StatusBadRequest = 400;
    private static readonly StatusNotFound = 404;
    private static readonly InvalidRequest = 'invalid_request';
    private static readonly InvalidClient = 'invalid_client';
    private static readonly UnsupportedResponseType = 'unsupported_response_type';
    private static readonly UnknownRealmDescription = 'unknown realm';
    private static readonly TooLongDescription = 'the request is too long';
    private static readonly BadResponseTypeDescription = 'response_type must be code';
    private static readonly UnknownClientDescription = 'unknown client';
    private static readonly BadRedirectDescription = 'redirect_uri is not registered for this client';
    private static readonly BadChallengeDescription = 'PKCE code_challenge with method S256 is required';
    private static readonly MissingStateNonceDescription = 'state and nonce are required';
    private static readonly BadPromptDescription = 'prompt=none cannot be combined with another prompt';

    private constructor(
        public readonly Client: OidcClient,
        public readonly RedirectUri: string,
        public readonly CodeChallenge: string,
        public readonly State: string,
        public readonly Nonce: string,
        public readonly Prompts: ReadonlySet<string>,
        public readonly LoginHint: string | undefined,
        public readonly Query: string)
    {
        Object.freeze(this);
    }

    /** The request when it is valid for the realm, else the refusal. */
    public static async Validate(realm: IdpRealm | undefined, clients: SqlIdpClientStore, query: string): Promise<AuthorizeRequest | AuthorizeRefusal>
    {
        const A = AuthorizeRequest;
        if (realm === undefined)
        {
            return new AuthorizeRefusal(A.StatusNotFound, A.InvalidRequest, A.UnknownRealmDescription);
        }
        if (query.length > A.MaxQueryChars)
        {
            return new AuthorizeRefusal(A.StatusBadRequest, A.InvalidRequest, A.TooLongDescription);
        }
        const params = new URLSearchParams(query);
        if (params.get(A.ResponseTypeParam) !== A.ResponseTypeCode)
        {
            return new AuthorizeRefusal(A.StatusBadRequest, A.UnsupportedResponseType, A.BadResponseTypeDescription);
        }
        const clientId = params.get(A.ClientIdParam);
        const client = clientId === null || clientId === A.NoValue ? undefined : await clients.Find(realm.Id, clientId);
        if (client === undefined)
        {
            return new AuthorizeRefusal(A.StatusBadRequest, A.InvalidClient, A.UnknownClientDescription);
        }
        const redirectUri = params.get(A.RedirectUriParam);
        if (redirectUri === null || redirectUri === A.NoValue || !client.RedirectAllowed(redirectUri))
        {
            return new AuthorizeRefusal(A.StatusBadRequest, A.InvalidRequest, A.BadRedirectDescription);
        }
        const challenge = params.get(A.CodeChallengeParam);
        if (challenge === null || challenge === A.NoValue || params.get(A.CodeChallengeMethodParam) !== A.MethodS256)
        {
            return new AuthorizeRefusal(A.StatusBadRequest, A.InvalidRequest, A.BadChallengeDescription);
        }
        const state = params.get(A.StateParam);
        const nonce = params.get(A.NonceParam);
        if (state === null || state === A.NoValue || nonce === null || nonce === A.NoValue)
        {
            return new AuthorizeRefusal(A.StatusBadRequest, A.InvalidRequest, A.MissingStateNonceDescription);
        }
        const prompts = new Set((params.get(A.PromptParam) ?? A.NoValue).split(A.PromptSeparator).filter(value => value !== A.NoValue));
        if (prompts.has(A.PromptNone) && prompts.size > 1)
        {
            return new AuthorizeRefusal(A.StatusBadRequest, A.InvalidRequest, A.BadPromptDescription);
        }
        const hint = params.get(A.LoginHintParam);
        return new AuthorizeRequest(client, redirectUri, challenge, state, nonce, prompts, hint === null || hint === A.NoValue ? undefined : hint, query);
    }

    /** `prompt=none`: never show the page. */
    public get Silent(): boolean
    {
        return this.Prompts.has(AuthorizeRequest.PromptNone);
    }

    /** `prompt=login` or `prompt=create`: an existing session does not answer the request. */
    public get BypassesSession(): boolean
    {
        return this.Prompts.has(AuthorizeRequest.PromptLogin) || this.Prompts.has(AuthorizeRequest.PromptCreate);
    }

    public get ClientId(): string
    {
        return this.Client.ClientId;
    }
}
