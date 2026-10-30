import { createHash, randomBytes } from 'node:crypto';
import type { IAuthorizationCodeStore } from './authorization-code-store.js';
import type { IdpClientStore } from './idp-client-store.js';
import type { IdpSigningKey } from './idp-signing-key.js';

export interface TokenResult
{
    status: number;
    body: object;
}

/** OAuth2 token endpoint: exchanges a single-use authorization code (+PKCE, +client secret) for an RS256 id_token. Fail-closed. */
export class TokenEndpoint
{
    private static readonly GrantType = 'grant_type';
    private static readonly AuthorizationCode = 'authorization_code';
    private static readonly CodeField = 'code';
    private static readonly VerifierField = 'code_verifier';
    private static readonly RedirectField = 'redirect_uri';
    private static readonly ClientIdField = 'client_id';
    private static readonly ClientSecretField = 'client_secret';
    private static readonly ErrorField = 'error';
    private static readonly InvalidGrant = 'invalid_grant';
    private static readonly InvalidClient = 'invalid_client';
    private static readonly StatusOk = 200;
    private static readonly StatusBadRequest = 400;
    private static readonly StatusUnauthorized = 401;
    private static readonly HashAlgorithm = 'sha256';
    private static readonly Base64Url = 'base64url';
    private static readonly AccessTokenBytes = 32;
    private static readonly LifetimeSeconds = 300;
    private static readonly MillisPerSecond = 1000;
    private static readonly BearerType = 'Bearer';
    private static readonly IdTokenField = 'id_token';
    private static readonly AccessTokenField = 'access_token';
    private static readonly TokenTypeField = 'token_type';
    private static readonly ExpiresInField = 'expires_in';
    private static readonly IssClaim = 'iss';
    private static readonly AudClaim = 'aud';
    private static readonly SubClaim = 'sub';
    private static readonly NonceClaim = 'nonce';
    private static readonly IatClaim = 'iat';
    private static readonly ExpClaim = 'exp';
    private static readonly EmailClaim = 'email';
    private static readonly NameClaim = 'name';
    private static readonly EmptyText = '';

    private readonly baseUrl: string;

    public constructor(
        baseUrl: string,
        private readonly signingKey: IdpSigningKey,
        private readonly codes: IAuthorizationCodeStore,
        private readonly clients: IdpClientStore,
        private readonly now: () => Date = () => new Date())
    {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
    }

    public async Handle(tenantId: string, form: URLSearchParams): Promise<TokenResult>
    {
        if (form.get(TokenEndpoint.GrantType) !== TokenEndpoint.AuthorizationCode)
        {
            return this.Fail(TokenEndpoint.StatusBadRequest, TokenEndpoint.InvalidGrant);
        }
        const clientId = form.get(TokenEndpoint.ClientIdField) ?? '';
        const secret = form.get(TokenEndpoint.ClientSecretField) ?? '';
        if (!(await this.clients.VerifySecret(tenantId, clientId, secret)))
        {
            return this.Fail(TokenEndpoint.StatusUnauthorized, TokenEndpoint.InvalidClient);
        }
        const code = form.get(TokenEndpoint.CodeField) ?? '';
        const verifier = form.get(TokenEndpoint.VerifierField) ?? '';
        const redirectUri = form.get(TokenEndpoint.RedirectField) ?? '';
        const binding = code === '' ? null : await this.codes.Take(code);
        if (binding === null
            || binding.TenantId !== tenantId
            || binding.ClientId !== clientId
            || binding.RedirectUri !== redirectUri
            || verifier === ''
            || createHash(TokenEndpoint.HashAlgorithm).update(verifier).digest(TokenEndpoint.Base64Url) !== binding.CodeChallenge
            || binding.Sub === '')
        {
            return this.Fail(TokenEndpoint.StatusBadRequest, TokenEndpoint.InvalidGrant);
        }
        const iat = Math.floor(this.now().getTime() / TokenEndpoint.MillisPerSecond);
        const claims: Record<string, unknown> = {
            [TokenEndpoint.IssClaim]: `${this.baseUrl}/${encodeURIComponent(tenantId)}`,
            [TokenEndpoint.AudClaim]: clientId,
            [TokenEndpoint.SubClaim]: binding.Sub,
            [TokenEndpoint.NonceClaim]: binding.Nonce,
            [TokenEndpoint.IatClaim]: iat,
            [TokenEndpoint.ExpClaim]: iat + TokenEndpoint.LifetimeSeconds,
            [TokenEndpoint.EmailClaim]: binding.Email
        };
        if (binding.Name !== TokenEndpoint.EmptyText)
        {
            claims[TokenEndpoint.NameClaim] = binding.Name;
        }
        const idToken = await this.signingKey.Sign(claims);
        return {
            status: TokenEndpoint.StatusOk,
            body: {
                [TokenEndpoint.IdTokenField]: idToken,
                [TokenEndpoint.AccessTokenField]: randomBytes(TokenEndpoint.AccessTokenBytes).toString(TokenEndpoint.Base64Url),
                [TokenEndpoint.TokenTypeField]: TokenEndpoint.BearerType,
                [TokenEndpoint.ExpiresInField]: TokenEndpoint.LifetimeSeconds
            }
        };
    }

    private Fail(status: number, error: string): TokenResult
    {
        return { status, body: { [TokenEndpoint.ErrorField]: error } };
    }
}
