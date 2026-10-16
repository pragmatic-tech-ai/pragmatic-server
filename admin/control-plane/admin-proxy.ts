import { AdminProtocol } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AccountDto, CreateAccountParams, GrantDto, GrantMutationDto, IdentityConfigDto, MessageConnection } from '@pragmatic-tech-ai/pragmatic-protocol'
import { UserSeeder } from '../../environments/seed/users.js'

export type AdminConnectInfo = { httpUrl: string; wsUrl: string; tenant: string; email: string; password: string }
export type AdminSnapshot = { accounts: AccountDto[]; grants: GrantDto[]; config: IdentityConfigDto }

export enum AdminProxyErrorKind
{
    Connect = 'connect',
    Rbac = 'rbac',
    Invalid = 'invalid',
    Protocol = 'protocol',
}

export class AdminProxyError extends Error
{
    private static readonly ErrorName = 'AdminProxyError'
    private static readonly ConnectMessage = 'could not connect to the environment'
    private static readonly RbacMessage = 'the environment rejected the change (access rules)'
    private static readonly InvalidMessage = 'the environment rejected the request as invalid'
    private static readonly ProtocolMessage = 'the environment admin request failed'

    public readonly Kind: AdminProxyErrorKind

    public constructor(kind: AdminProxyErrorKind, message?: string)
    {
        super(message ?? AdminProxyError.DefaultMessage(kind))
        this.name = AdminProxyError.ErrorName
        this.Kind = kind
    }

    private static DefaultMessage(kind: AdminProxyErrorKind): string
    {
        switch (kind)
        {
            case AdminProxyErrorKind.Connect:
                return AdminProxyError.ConnectMessage
            case AdminProxyErrorKind.Rbac:
                return AdminProxyError.RbacMessage
            case AdminProxyErrorKind.Invalid:
                return AdminProxyError.InvalidMessage
            default:
                return AdminProxyError.ProtocolMessage
        }
    }
}

export interface IAdminConnection
{
    ListAccounts(): Promise<AccountDto[]>
    CreateAccount(params: CreateAccountParams): Promise<void>
    DisableAccount(principalId: string): Promise<void>
    ListGrants(subject: string): Promise<GrantDto[]>
    GrantRole(mutation: GrantMutationDto): Promise<void>
    RevokeRole(mutation: GrantMutationDto): Promise<void>
    GetConfig(): Promise<IdentityConfigDto>
    SetConfig(config: IdentityConfigDto): Promise<void>
    Dispose(): void
}

export interface IAdminConnector
{
    Open(info: AdminConnectInfo): Promise<IAdminConnection>
}

export interface IAdminProxy
{
    LoadAdmin(info: AdminConnectInfo): Promise<AdminSnapshot>
    CreateAccount(info: AdminConnectInfo, params: CreateAccountParams): Promise<void>
    DisableAccount(info: AdminConnectInfo, principalId: string): Promise<void>
    GrantRole(info: AdminConnectInfo, mutation: GrantMutationDto): Promise<void>
    RevokeRole(info: AdminConnectInfo, mutation: GrantMutationDto): Promise<void>
    GetConfig(info: AdminConnectInfo): Promise<IdentityConfigDto>
    SetConfig(info: AdminConnectInfo, config: IdentityConfigDto): Promise<void>
}

/** Typed facade over the environment admin protocol; one short-lived authenticated connection per call. */
export class AdminProxy implements IAdminProxy
{
    private static readonly SelfLockoutText = 'cannot revoke your own'
    private static readonly LastAdminText = 'last administrator'
    private static readonly InvalidParamsText = 'invalid params'

    public constructor(private readonly connector: IAdminConnector)
    {
    }

    public async LoadAdmin(info: AdminConnectInfo): Promise<AdminSnapshot>
    {
        return this.With(info, async conn =>
        {
            const accounts = await conn.ListAccounts()
            const grants: GrantDto[] = []
            for (const account of accounts)
            {
                grants.push(...await conn.ListGrants(account.principalId))
            }
            const config = await conn.GetConfig()
            return { accounts, grants, config }
        })
    }

    public async CreateAccount(info: AdminConnectInfo, params: CreateAccountParams): Promise<void>
    {
        await this.With(info, conn => conn.CreateAccount(params))
    }

    public async DisableAccount(info: AdminConnectInfo, principalId: string): Promise<void>
    {
        await this.With(info, conn => conn.DisableAccount(principalId))
    }

    public async GrantRole(info: AdminConnectInfo, mutation: GrantMutationDto): Promise<void>
    {
        await this.With(info, conn => conn.GrantRole(mutation))
    }

    public async RevokeRole(info: AdminConnectInfo, mutation: GrantMutationDto): Promise<void>
    {
        await this.With(info, conn => conn.RevokeRole(mutation))
    }

    public async GetConfig(info: AdminConnectInfo): Promise<IdentityConfigDto>
    {
        return this.With(info, conn => conn.GetConfig())
    }

    public async SetConfig(info: AdminConnectInfo, config: IdentityConfigDto): Promise<void>
    {
        await this.With(info, conn => conn.SetConfig(config))
    }

    private async With<T>(info: AdminConnectInfo, body: (conn: IAdminConnection) => Promise<T>): Promise<T>
    {
        let conn: IAdminConnection
        try
        {
            conn = await this.connector.Open(info)
        }
        catch (err)
        {
            throw err instanceof AdminProxyError ? err : new AdminProxyError(AdminProxyErrorKind.Connect, AdminProxy.MessageOf(err))
        }
        try
        {
            return await body(conn)
        }
        catch (err)
        {
            throw AdminProxy.Classify(err)
        }
        finally
        {
            conn.Dispose()
        }
    }

    private static MessageOf(err: unknown): string
    {
        return err instanceof Error ? err.message : String(err)
    }

    private static Classify(err: unknown): AdminProxyError
    {
        if (err instanceof AdminProxyError)
        {
            return err
        }
        const message = AdminProxy.MessageOf(err)
        if (message.includes(AdminProxy.SelfLockoutText) || message.includes(AdminProxy.LastAdminText))
        {
            return new AdminProxyError(AdminProxyErrorKind.Rbac, message)
        }
        if (message.toLowerCase().includes(AdminProxy.InvalidParamsText))
        {
            return new AdminProxyError(AdminProxyErrorKind.Invalid, message)
        }
        return new AdminProxyError(AdminProxyErrorKind.Protocol, message)
    }
}

/** Real connection: typed requests over a JSON-RPC MessageConnection. */
export class WsAdminConnection implements IAdminConnection
{
    public constructor(private readonly conn: MessageConnection)
    {
    }

    public ListAccounts(): Promise<AccountDto[]>
    {
        return this.conn.sendRequest(AdminProtocol.ListAccounts, undefined) as Promise<AccountDto[]>
    }

    public async CreateAccount(params: CreateAccountParams): Promise<void>
    {
        await this.conn.sendRequest(AdminProtocol.CreateAccount, params)
    }

    public async DisableAccount(principalId: string): Promise<void>
    {
        await this.conn.sendRequest(AdminProtocol.DisableAccount, { principalId })
    }

    public ListGrants(subject: string): Promise<GrantDto[]>
    {
        return this.conn.sendRequest(AdminProtocol.ListGrants, { subject }) as Promise<GrantDto[]>
    }

    public async GrantRole(mutation: GrantMutationDto): Promise<void>
    {
        await this.conn.sendRequest(AdminProtocol.GrantRole, mutation)
    }

    public async RevokeRole(mutation: GrantMutationDto): Promise<void>
    {
        await this.conn.sendRequest(AdminProtocol.RevokeRole, mutation)
    }

    public GetConfig(): Promise<IdentityConfigDto>
    {
        return this.conn.sendRequest(AdminProtocol.GetConfig, undefined) as Promise<IdentityConfigDto>
    }

    public async SetConfig(config: IdentityConfigDto): Promise<void>
    {
        await this.conn.sendRequest(AdminProtocol.SetConfig, config)
    }

    public Dispose(): void
    {
        this.conn.dispose()
    }
}

export class WsAdminConnector implements IAdminConnector
{
    public async Open(info: AdminConnectInfo): Promise<IAdminConnection>
    {
        const seeder = new UserSeeder()
        const token = await seeder.Login(info.httpUrl, info.tenant, info.email, info.password)
        const conn = await seeder.Connect(info.wsUrl, info.tenant, token)
        return new WsAdminConnection(conn)
    }
}
