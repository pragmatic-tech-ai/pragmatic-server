import { AuthMethod, Credential, PresentedSecret, AuthenticatedResult } from '@pragmatic-tech-ai/todl-identity'
import type { Tenant } from '@pragmatic-tech-ai/todl-identity'
import type { OidcAuthenticator } from '@pragmatic-tech-ai/todl-identity-cloud'
import type { ServerIdentityPack } from '@pragmatic-tech-ai/todl-identity-node'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { RequestBody } from './request-body.js'

/** Minimal deny-by-default token-issuance router: local login + OIDC begin/callback.
 *  Secrets cross as PresentedSecret and are cleared; failures return a generic 401. */
export class AuthHttpEndpoint
{
    private static readonly BaseUrl = 'http://localhost'
    private static readonly LoginPath = '/auth/login'
    private static readonly OidcBeginPath = '/auth/oidc/begin'
    private static readonly OidcCallbackPath = '/auth/oidc/callback'
    private static readonly PostMethod = 'POST'
    private static readonly GetMethod = 'GET'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly LocationHeader = 'Location'
    private static readonly JsonContentType = 'application/json'
    private static readonly MaxBodyBytes = 4096
    private static readonly CodeParam = 'code'
    private static readonly StateParam = 'state'
    private static readonly InvalidCredentialsError = 'invalid email or password'
    private static readonly BadRequestError = 'bad request'
    private static readonly NotFoundError = 'not found'
    private static readonly MethodNotAllowedError = 'method not allowed'

    private readonly pack: ServerIdentityPack
    private readonly tenant: Tenant
    private readonly oidc: OidcAuthenticator | undefined

    public constructor(pack: ServerIdentityPack, tenant: Tenant, oidc?: OidcAuthenticator)
    {
        this.pack = pack
        this.tenant = tenant
        this.oidc = oidc
    }

    public async Handle(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const url = new URL(req.url ?? '/', AuthHttpEndpoint.BaseUrl)
        const method = req.method ?? AuthHttpEndpoint.GetMethod
        if (url.pathname === AuthHttpEndpoint.LoginPath)
        {
            if (method !== AuthHttpEndpoint.PostMethod)
            {
                this.WriteJson(res, 405, AuthHttpEndpoint.MethodNotAllowedError)
                return
            }
            await this.Login(req, res)
            return
        }
        if (url.pathname === AuthHttpEndpoint.OidcBeginPath)
        {
            if (method !== AuthHttpEndpoint.GetMethod)
            {
                this.WriteJson(res, 405, AuthHttpEndpoint.MethodNotAllowedError)
                return
            }
            await this.OidcBegin(res)
            return
        }
        if (url.pathname === AuthHttpEndpoint.OidcCallbackPath)
        {
            if (method !== AuthHttpEndpoint.GetMethod)
            {
                this.WriteJson(res, 405, AuthHttpEndpoint.MethodNotAllowedError)
                return
            }
            await this.OidcCallback(url, res)
            return
        }
        this.WriteJson(res, 404, AuthHttpEndpoint.NotFoundError)
    }

    private async Login(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const body = await RequestBody.ReadJson(req, AuthHttpEndpoint.MaxBodyBytes)
        if (body === null || typeof body.email !== 'string' || typeof body.password !== 'string')
        {
            this.WriteJson(res, 400, AuthHttpEndpoint.BadRequestError)
            return
        }
        const authenticator = this.pack.AuthenticatorFor(AuthMethod.Local)
        if (authenticator === undefined)
        {
            this.WriteJson(res, 401, AuthHttpEndpoint.InvalidCredentialsError)
            return
        }
        const presented = new PresentedSecret(body.password)
        try
        {
            const result = await authenticator.Authenticate(new Credential(AuthMethod.Local, body.email), presented, this.tenant)
            if (!(result instanceof AuthenticatedResult))
            {
                this.WriteJson(res, 401, AuthHttpEndpoint.InvalidCredentialsError)
                return
            }
            await this.MintSession(res, result)
        }
        finally
        {
            presented.Clear()
        }
    }

    private async OidcBegin(res: ServerResponse): Promise<void>
    {
        if (this.oidc === undefined)
        {
            this.WriteJson(res, 404, AuthHttpEndpoint.NotFoundError)
            return
        }
        const begun = await this.oidc.BeginAuthorization(this.tenant)
        res.statusCode = 302
        res.setHeader(AuthHttpEndpoint.LocationHeader, begun.Url)
        res.end()
    }

    private async OidcCallback(url: URL, res: ServerResponse): Promise<void>
    {
        if (this.oidc === undefined)
        {
            this.WriteJson(res, 404, AuthHttpEndpoint.NotFoundError)
            return
        }
        const code = url.searchParams.get(AuthHttpEndpoint.CodeParam)
        const state = url.searchParams.get(AuthHttpEndpoint.StateParam)
        if (code === null || state === null)
        {
            this.WriteJson(res, 400, AuthHttpEndpoint.BadRequestError)
            return
        }
        const presented = new PresentedSecret(code)
        try
        {
            const result = await this.oidc.Authenticate(new Credential(AuthMethod.Oidc, state), presented, this.tenant)
            if (!(result instanceof AuthenticatedResult))
            {
                this.WriteJson(res, 401, AuthHttpEndpoint.InvalidCredentialsError)
                return
            }
            await this.MintSession(res, result)
        }
        finally
        {
            presented.Clear()
        }
    }

    private async MintSession(res: ServerResponse, result: AuthenticatedResult): Promise<void>
    {
        const session = await this.pack.Sessions.Issue(result.Principal)
        this.WriteBody(res, 200, JSON.stringify({ token: session.Id, expiresAt: session.ExpiresAt.toISOString() }))
    }

    private WriteJson(res: ServerResponse, status: number, error: string): void
    {
        this.WriteBody(res, status, JSON.stringify({ error }))
    }

    private WriteBody(res: ServerResponse, status: number, body: string): void
    {
        res.statusCode = status
        res.setHeader(AuthHttpEndpoint.ContentTypeHeader, AuthHttpEndpoint.JsonContentType)
        res.end(body)
    }
}
