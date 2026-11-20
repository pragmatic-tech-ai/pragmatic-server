import { IdentityPlatformRestError, type IdentityPlatformPageConfig } from '@pragmatic-tech-ai/pragmatic-identity-source-identity-platform/client'

// Where a federated sign-in sends the browser, and the Identity Platform
// session that must accompany the provider's answer.
export class FederatedAuthUri
{
    public constructor(public readonly AuthUri: string, public readonly SessionId: string)
    {
    }
}

// Federated sign-in (Google) through Identity Platform's identitytoolkit v1
// REST endpoints, in the same style as the shared IdentityPlatformRestClient
// (which has no federated calls): accounts:createAuthUri starts the provider's
// round trip, accounts:signInWithIdp exchanges the provider's answer (the URL
// the browser came back to) for an Identity Platform ID token.
export class IdentityPlatformFederation
{
    public static readonly DefaultBaseUrl = 'https://identitytoolkit.googleapis.com/v1/'

    private static readonly CreateAuthUriPath = 'accounts:createAuthUri'
    private static readonly SignInWithIdpPath = 'accounts:signInWithIdp'
    private static readonly KeyParam = 'key'
    private static readonly PostMethod = 'POST'
    private static readonly ContentTypeHeader = 'content-type'
    private static readonly JsonContentType = 'application/json'
    private static readonly MissingFieldCode = 'MALFORMED_RESPONSE'
    private static readonly MissingFieldDetail = 'a response field is missing'

    private readonly fetchFn: typeof fetch

    public constructor(
        private readonly apiKey: string,
        private readonly tenantId: string | null = null,
        fetchFn?: typeof fetch,
        private readonly baseUrl: string = IdentityPlatformFederation.DefaultBaseUrl)
    {
        this.fetchFn = fetchFn ?? globalThis.fetch.bind(globalThis)
    }

    public static For(config: IdentityPlatformPageConfig, fetchFn?: typeof fetch): IdentityPlatformFederation
    {
        return new IdentityPlatformFederation(config.ApiKey, config.TenantId, fetchFn)
    }

    // Starts a sign-in with `providerId` (e.g. 'google.com'); the provider sends the browser back to `continueUri`.
    public async CreateAuthUri(providerId: string, continueUri: string): Promise<FederatedAuthUri>
    {
        const body = await this.Post(IdentityPlatformFederation.CreateAuthUriPath, { providerId, continueUri }) as { authUri?: unknown; sessionId?: unknown }
        if (typeof body.authUri !== 'string' || typeof body.sessionId !== 'string')
        {
            throw IdentityPlatformFederation.Malformed()
        }
        return new FederatedAuthUri(body.authUri, body.sessionId)
    }

    // Signs in with the provider's answer: `requestUri` is the URL the provider sent the browser back to.
    public async SignInWithIdp(requestUri: string, sessionId: string): Promise<string>
    {
        const body = await this.Post(IdentityPlatformFederation.SignInWithIdpPath, {
            requestUri,
            sessionId,
            returnSecureToken: true,
            returnIdpCredential: true,
        }) as { idToken?: unknown }
        if (typeof body.idToken !== 'string')
        {
            throw IdentityPlatformFederation.Malformed()
        }
        return body.idToken
    }

    private static Malformed(): IdentityPlatformRestError
    {
        return new IdentityPlatformRestError(IdentityPlatformFederation.MissingFieldCode, 0, IdentityPlatformFederation.MissingFieldDetail)
    }

    private async Post(path: string, fields: Record<string, unknown>): Promise<Record<string, unknown>>
    {
        const F = IdentityPlatformFederation
        // Concatenated, not new URL(path, base): "accounts:createAuthUri" parses as an absolute URL with scheme "accounts:".
        const url = new URL(this.baseUrl + path)
        url.searchParams.set(F.KeyParam, this.apiKey)
        const body = this.tenantId === null ? fields : { ...fields, tenantId: this.tenantId }
        const response = await this.fetchFn(url.href, {
            method: F.PostMethod,
            headers: { [F.ContentTypeHeader]: F.JsonContentType },
            body: JSON.stringify(body),
        })
        const json: unknown = await response.json().catch(() => null)
        if (!response.ok)
        {
            throw IdentityPlatformRestError.FromBody(response.status, json)
        }
        return json !== null && typeof json === 'object' ? json as Record<string, unknown> : {}
    }
}
