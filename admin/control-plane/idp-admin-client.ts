import * as https from 'node:https';

/** Non-2xx reply from the IdP admin API. Carries only status + server error code, never request data. */
export class IdpAdminError extends Error
{
    private static readonly Prefix = 'IdP admin request failed with status ';
    private static readonly CodeSeparator = ': ';

    public constructor(public readonly Status: number, public readonly Code?: string)
    {
        super(IdpAdminError.Prefix + Status + (Code === undefined ? '' : IdpAdminError.CodeSeparator + Code));
        this.name = 'IdpAdminError';
    }
}

export interface IdpAdminClientOptions
{
    baseUrl: string;
    adminToken: string;
    ca: string | Buffer;
}

/** Typed HTTPS client for the IdP `/_admin/` provisioning API; trusts only the supplied CA. */
export class IdpAdminClient
{
    private static readonly RealmsPath = '/_admin/realms/';
    private static readonly AccountsSuffix = '/accounts';
    private static readonly ClientsSuffix = '/clients';
    private static readonly PutMethod = 'PUT';
    private static readonly PostMethod = 'POST';
    private static readonly AuthorizationHeader = 'Authorization';
    private static readonly ContentTypeHeader = 'Content-Type';
    private static readonly ContentLengthHeader = 'Content-Length';
    private static readonly BearerPrefix = 'Bearer ';
    private static readonly JsonType = 'application/json';
    private static readonly Utf8 = 'utf8';
    private static readonly ErrorField = 'error';
    private static readonly OkMin = 200;
    private static readonly OkMax = 300;

    private readonly agent: https.Agent;
    private readonly base: URL;

    public constructor(private readonly opts: IdpAdminClientOptions)
    {
        this.agent = new https.Agent({ ca: opts.ca });
        this.base = new URL(opts.baseUrl);
    }

    public async EnsureRealm(tenantId: string, displayName: string): Promise<void>
    {
        await this.Request(IdpAdminClient.PutMethod, this.RealmPath(tenantId), { displayName });
    }

    public async SeedAccount(tenantId: string, account: { email: string; principalId: string; displayName: string; password: string }): Promise<void>
    {
        await this.Request(IdpAdminClient.PostMethod, this.RealmPath(tenantId) + IdpAdminClient.AccountsSuffix,
            { email: account.email, principalId: account.principalId, displayName: account.displayName, password: account.password });
    }

    public async RegisterClient(tenantId: string, client: { clientId: string; redirectUris: readonly string[]; secret: string }): Promise<void>
    {
        await this.Request(IdpAdminClient.PostMethod, this.RealmPath(tenantId) + IdpAdminClient.ClientsSuffix,
            { clientId: client.clientId, redirectUris: client.redirectUris, secret: client.secret });
    }

    private RealmPath(tenantId: string): string
    {
        return IdpAdminClient.RealmsPath + encodeURIComponent(tenantId);
    }

    private Request(method: string, urlPath: string, body: unknown): Promise<void>
    {
        const payload = Buffer.from(JSON.stringify(body), IdpAdminClient.Utf8);
        return new Promise<void>((resolve, reject) =>
        {
            const req = https.request({
                agent: this.agent,
                host: this.base.hostname,
                port: this.base.port,
                path: urlPath,
                method,
                headers: {
                    [IdpAdminClient.AuthorizationHeader]: IdpAdminClient.BearerPrefix + this.opts.adminToken,
                    [IdpAdminClient.ContentTypeHeader]: IdpAdminClient.JsonType,
                    [IdpAdminClient.ContentLengthHeader]: payload.length
                }
            }, res =>
            {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () =>
                {
                    const status = res.statusCode ?? 0;
                    if (status >= IdpAdminClient.OkMin && status < IdpAdminClient.OkMax)
                    {
                        resolve();
                        return;
                    }
                    reject(new IdpAdminError(status, IdpAdminClient.ParseCode(Buffer.concat(chunks).toString(IdpAdminClient.Utf8))));
                });
                res.on('error', reject);
            });
            req.on('error', reject);
            req.end(payload);
        });
    }

    private static ParseCode(text: string): string | undefined
    {
        try
        {
            const parsed: unknown = JSON.parse(text);
            if (typeof parsed === 'object' && parsed !== null)
            {
                const code = (parsed as Record<string, unknown>)[IdpAdminClient.ErrorField];
                return typeof code === 'string' ? code : undefined;
            }
        }
        catch
        {
            return undefined;
        }
        return undefined;
    }
}
