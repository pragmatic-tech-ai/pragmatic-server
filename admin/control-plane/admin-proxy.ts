/** Later-slice seam: proxying admin-API calls to a running environment's server. Not wired into the host this slice. */
export interface IAdminProxy
{
    ForwardLogin(tenant: string, email: string, password: string): Promise<string>
    Forward(envName: string, method: string, path: string, body?: unknown): Promise<unknown>
}

export class AdminProxyNotImplementedError extends Error
{
    private static readonly ErrorName = 'AdminProxyNotImplementedError'
    private static readonly DefaultMessage = 'Admin proxy is not implemented in this slice'

    public constructor()
    {
        super(AdminProxyNotImplementedError.DefaultMessage)
        this.name = AdminProxyNotImplementedError.ErrorName
    }
}

export class StubAdminProxy implements IAdminProxy
{
    public async ForwardLogin(_tenant: string, _email: string, _password: string): Promise<string>
    {
        throw new AdminProxyNotImplementedError()
    }

    public async Forward(_envName: string, _method: string, _path: string, _body?: unknown): Promise<unknown>
    {
        throw new AdminProxyNotImplementedError()
    }
}
