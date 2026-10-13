import { AuthMethod, Credential, PresentedSecret, AuthenticatedResult } from '@pragmatic-tech-ai/todl-identity'
import type { IAuthenticator, Tenant } from '@pragmatic-tech-ai/todl-identity'
import type { OidcAuthenticator } from '@pragmatic-tech-ai/todl-identity-cloud'
import type { ServerIdentityPack } from '@pragmatic-tech-ai/todl-identity-node'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { RequestBody } from './request-body.js'
import type { MachineCertIdentity } from './machine-principal-map.js'

/** A verified TLS peer identity plus the tenant's Machine authenticator; absent when client TLS is not configured. */
export interface MachineAuthContext
{
    authenticator: IAuthenticator
    identity: MachineCertIdentity
}

/** Minimal deny-by-default token-issuance router: local login + OIDC begin/callback.
 *  Secrets cross as PresentedSecret and are cleared; failures return a generic 401. */
export class AuthHttpEndpoint
{
    private static readonly BaseUrl = 'http://localhost'
    private static readonly LoginPath = '/auth/login'
    private static readonly OidcBeginPath = '/auth/oidc/begin'
    private static readonly OidcCallbackPath = '/auth/oidc/callback'
    private static readonly MachinePath = '/auth/machine'
    private static readonly MachineUnauthorizedError = 'machine authentication failed'
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
    private static readonly InternalError = 'internal error'
    private static readonly OkStatus = 200
    private static readonly FoundStatus = 302
    private static readonly BadRequestStatus = 400
    private static readonly UnauthorizedStatus = 401
    private static readonly NotFoundStatus = 404
    private static readonly MethodNotAllowedStatus = 405
    private static readonly InternalErrorStatus = 500
    private static readonly EmailKey = 'email'
    private static readonly PasswordKey = 'password'
    private static readonly TokenKey = 'token'
    private static readonly ExpiresAtKey = 'expiresAt'
    private static readonly ErrorKey = 'error'
    private static readonly CacheControlHeader = 'Cache-Control'
    private static readonly NoStore = 'no-store'

    private readonly pack: ServerIdentityPack
    private readonly tenant: Tenant
    private readonly oidc: OidcAuthenticator | undefined
    private readonly machine: MachineAuthContext | undefined

    public constructor(pack: ServerIdentityPack, tenant: Tenant, oidc?: OidcAuthenticator, machine?: MachineAuthContext)
    {
        this.machine = machine
        this.pack = pack
        this.tenant = tenant
        this.oidc = oidc
    }

    public async Handle(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        try
        {
            await this.Route(req, res)
        }
        catch
        {
            if (res.headersSent)
            {
                res.end()
            }
            else
            {
                this.WriteJson(res, AuthHttpEndpoint.InternalErrorStatus, AuthHttpEndpoint.InternalError)
            }
        }
    }

    private async Route(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const url = new URL(req.url ?? '/', AuthHttpEndpoint.BaseUrl)
        const method = req.method ?? AuthHttpEndpoint.GetMethod
        if (url.pathname === AuthHttpEndpoint.LoginPath)
        {
            if (method !== AuthHttpEndpoint.PostMethod)
            {
                this.WriteJson(res, AuthHttpEndpoint.MethodNotAllowedStatus, AuthHttpEndpoint.MethodNotAllowedError)
                return
            }
            await this.Login(req, res)
            return
        }
        if (url.pathname === AuthHttpEndpoint.OidcBeginPath)
        {
            if (this.oidc === undefined)
            {
                this.WriteJson(res, AuthHttpEndpoint.NotFoundStatus, AuthHttpEndpoint.NotFoundError)
                return
            }
            if (method !== AuthHttpEndpoint.GetMethod)
            {
                this.WriteJson(res, AuthHttpEndpoint.MethodNotAllowedStatus, AuthHttpEndpoint.MethodNotAllowedError)
                return
            }
            await this.OidcBegin(res)
            return
        }
        if (url.pathname === AuthHttpEndpoint.OidcCallbackPath)
        {
            if (this.oidc === undefined)
            {
                this.WriteJson(res, AuthHttpEndpoint.NotFoundStatus, AuthHttpEndpoint.NotFoundError)
                return
            }
            if (method !== AuthHttpEndpoint.GetMethod)
            {
                this.WriteJson(res, AuthHttpEndpoint.MethodNotAllowedStatus, AuthHttpEndpoint.MethodNotAllowedError)
                return
            }
            await this.OidcCallback(url, res)
            return
        }
        if (url.pathname === AuthHttpEndpoint.MachinePath)
        {
            if (this.machine === undefined)
            {
                this.WriteJson(res, AuthHttpEndpoint.NotFoundStatus, AuthHttpEndpoint.NotFoundError)
                return
            }
            if (method !== AuthHttpEndpoint.PostMethod)
            {
                this.WriteJson(res, AuthHttpEndpoint.MethodNotAllowedStatus, AuthHttpEndpoint.MethodNotAllowedError)
                return
            }
            await this.MachineLogin(this.machine, res)
            return
        }
        this.WriteJson(res, AuthHttpEndpoint.NotFoundStatus, AuthHttpEndpoint.NotFoundError)
    }

    private async MachineLogin(machine: MachineAuthContext, res: ServerResponse): Promise<void>
    {
        if (machine.identity.Authorized !== true || machine.identity.Fingerprint.length === 0)
        {
            this.WriteJson(res, AuthHttpEndpoint.UnauthorizedStatus, AuthHttpEndpoint.MachineUnauthorizedError)
            return
        }
        const result = await machine.authenticator.Authenticate(new Credential(AuthMethod.Machine, machine.identity.Fingerprint), new PresentedSecret(''), this.tenant)
        if (!(result instanceof AuthenticatedResult))
        {
            this.WriteJson(res, AuthHttpEndpoint.UnauthorizedStatus, AuthHttpEndpoint.MachineUnauthorizedError)
            return
        }
        await this.MintSession(res, result)
    }

    private async Login(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const body = await RequestBody.ReadJson(req, AuthHttpEndpoint.MaxBodyBytes)
        const email = body?.[AuthHttpEndpoint.EmailKey]
        const password = body?.[AuthHttpEndpoint.PasswordKey]
        if (typeof email !== 'string' || typeof password !== 'string')
        {
            this.WriteJson(res, AuthHttpEndpoint.BadRequestStatus, AuthHttpEndpoint.BadRequestError)
            return
        }
        const authenticator = this.pack.AuthenticatorFor(AuthMethod.Local)
        if (authenticator === undefined)
        {
            this.WriteJson(res, AuthHttpEndpoint.UnauthorizedStatus, AuthHttpEndpoint.InvalidCredentialsError)
            return
        }
        const presented = new PresentedSecret(password)
        try
        {
            const result = await authenticator.Authenticate(new Credential(AuthMethod.Local, email), presented, this.tenant)
            if (!(result instanceof AuthenticatedResult))
            {
                this.WriteJson(res, AuthHttpEndpoint.UnauthorizedStatus, AuthHttpEndpoint.InvalidCredentialsError)
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
            this.WriteJson(res, AuthHttpEndpoint.NotFoundStatus, AuthHttpEndpoint.NotFoundError)
            return
        }
        const begun = await this.oidc.BeginAuthorization(this.tenant)
        res.statusCode = AuthHttpEndpoint.FoundStatus
        res.setHeader(AuthHttpEndpoint.LocationHeader, begun.Url)
        res.end()
    }

    private async OidcCallback(url: URL, res: ServerResponse): Promise<void>
    {
        if (this.oidc === undefined)
        {
            this.WriteJson(res, AuthHttpEndpoint.NotFoundStatus, AuthHttpEndpoint.NotFoundError)
            return
        }
        const code = url.searchParams.get(AuthHttpEndpoint.CodeParam)
        const state = url.searchParams.get(AuthHttpEndpoint.StateParam)
        if (code === null || state === null)
        {
            this.WriteJson(res, AuthHttpEndpoint.BadRequestStatus, AuthHttpEndpoint.BadRequestError)
            return
        }
        const presented = new PresentedSecret(code)
        try
        {
            const result = await this.oidc.Authenticate(new Credential(AuthMethod.Oidc, state), presented, this.tenant)
            if (!(result instanceof AuthenticatedResult))
            {
                this.WriteJson(res, AuthHttpEndpoint.UnauthorizedStatus, AuthHttpEndpoint.InvalidCredentialsError)
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
        this.WriteBody(res, AuthHttpEndpoint.OkStatus, JSON.stringify({ [AuthHttpEndpoint.TokenKey]: session.Id, [AuthHttpEndpoint.ExpiresAtKey]: session.ExpiresAt.toISOString() }))
    }

    private WriteJson(res: ServerResponse, status: number, error: string): void
    {
        this.WriteBody(res, status, JSON.stringify({ [AuthHttpEndpoint.ErrorKey]: error }))
    }

    private WriteBody(res: ServerResponse, status: number, body: string): void
    {
        if (res.writableEnded)
        {
            return
        }
        res.statusCode = status
        res.setHeader(AuthHttpEndpoint.ContentTypeHeader, AuthHttpEndpoint.JsonContentType)
        res.setHeader(AuthHttpEndpoint.CacheControlHeader, AuthHttpEndpoint.NoStore)
        res.end(body)
    }
}
