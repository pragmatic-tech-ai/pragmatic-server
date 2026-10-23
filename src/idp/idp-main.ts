import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryAuthorizationCodeStore } from './authorization-code-store.js';
import { DevCa, IdpTlsMaterial } from './dev-ca.js';
import { IdpClientStore } from './idp-client-store.js';
import { IdpHost, IdpRealmSet } from './idp-host.js';
import { IdpRealm } from './idp-realm.js';
import { IdpSigningKey } from './idp-signing-key.js';
import { IdpSsoSessionStore } from './idp-sso-session.js';

/** Env-driven launcher for the local `pragmatic-idp` service (single instance; in-memory client/code/SSO stores). */
export class IdpMain
{
    private static readonly PortEnvVar = 'PRAGMATIC_IDP_PORT';
    private static readonly BaseUrlEnvVar = 'PRAGMATIC_IDP_BASE_URL';
    private static readonly HostEnvVar = 'PRAGMATIC_IDP_HOST';
    private static readonly DataEnvVar = 'PRAGMATIC_IDP_DATA';
    private static readonly SecureCookieEnvVar = 'PRAGMATIC_IDP_SECURE_COOKIE';
    private static readonly TenantsEnvVar = 'PRAGMATIC_IDP_TENANTS';
    private static readonly DefaultPort = 7100;
    private static readonly MaxPort = 65535;
    private static readonly DefaultHost = '127.0.0.1';
    private static readonly DataDir = 'data';
    private static readonly SigningKeyFile = 'signing-key.pem';
    private static readonly MasterKeyFile = 'master.key';
    private static readonly TlsDir = 'tls';
    private static readonly RealmsDir = 'realms';
    private static readonly MasterKeyBytes = 32;
    private static readonly KeyFileMode = 0o600;
    private static readonly TenantSeparator = ',';
    private static readonly FalseToken = 'false';
    private static readonly ZeroToken = '0';
    private static readonly MissingBaseUrlMessage = 'PRAGMATIC_IDP_BASE_URL is required (an https origin)';
    private static readonly BadBaseUrlMessage = 'PRAGMATIC_IDP_BASE_URL must be a valid https URL';
    private static readonly HttpsProtocol = 'https:';
    private static readonly FailPrefix = 'pragmatic-idp failed to start: ';
    private static readonly FailExitCode = 1;
    private static readonly BadPortPrefix = 'Invalid PRAGMATIC_IDP_PORT: ';
    private static readonly BadMasterKeyMessage = 'IdP master key file must be exactly 32 bytes';
    private static readonly ListeningPrefix = 'pragmatic-idp listening on ';

    public static async Run(): Promise<void>
    {
        const host = await IdpMain.Compose(process.env);
        const bind = process.env[IdpMain.HostEnvVar] ?? IdpMain.DefaultHost;
        const port = IdpMain.ResolvePort(process.env[IdpMain.PortEnvVar]);
        await host.Listen(port, bind);
        console.log(IdpMain.ListeningPrefix + process.env[IdpMain.BaseUrlEnvVar]);
    }

    /** Builds every collaborator from the environment and returns a not-yet-listening host. */
    public static async Compose(env: NodeJS.ProcessEnv): Promise<IdpHost>
    {
        const baseUrl = env[IdpMain.BaseUrlEnvVar];
        if (baseUrl === undefined || baseUrl === '')
        {
            throw new Error(IdpMain.MissingBaseUrlMessage);
        }
        IdpMain.RequireHttps(baseUrl);
        const data = env[IdpMain.DataEnvVar] ?? join(dirname(fileURLToPath(import.meta.url)), IdpMain.DataDir);
        mkdirSync(data, { recursive: true });
        const signingKey = await IdpSigningKey.LoadOrCreate(join(data, IdpMain.SigningKeyFile));
        const masterKey = IdpMain.LoadOrCreateMasterKey(join(data, IdpMain.MasterKeyFile));
        const realms = new IdpRealmSet();
        for (const tenantId of IdpMain.ParseTenants(env[IdpMain.TenantsEnvVar]))
        {
            realms.Add(tenantId, await IdpRealm.OpenFor(join(data, IdpMain.RealmsDir), tenantId, tenantId, masterKey));
        }
        const ca = DevCa.EnsureAt(join(data, IdpMain.TlsDir), new URL(baseUrl).hostname);
        const tls = IdpTlsMaterial.Load({ certFile: ca.certFile, keyFile: ca.keyFile });
        const secure = env[IdpMain.SecureCookieEnvVar];
        const secureCookie = secure !== IdpMain.ZeroToken && secure !== IdpMain.FalseToken;
        return new IdpHost(baseUrl, signingKey, realms, new IdpClientStore(), new InMemoryAuthorizationCodeStore(), new IdpSsoSessionStore(), tls, secureCookie);
    }

    /** Prints a concise startup failure (message only, no stack) and sets a non-zero exit code. */
    public static Fail(err: unknown): void
    {
        console.error(IdpMain.FailPrefix + (err instanceof Error ? err.message : String(err)));
        process.exitCode = IdpMain.FailExitCode;
    }

    private static RequireHttps(baseUrl: string): void
    {
        let protocol: string | undefined;
        try
        {
            protocol = new URL(baseUrl).protocol;
        }
        catch
        {
            protocol = undefined;
        }
        if (protocol !== IdpMain.HttpsProtocol)
        {
            throw new Error(IdpMain.BadBaseUrlMessage);
        }
    }

    /** True when this module is the process entry point (not when imported by tests); the bin starts Run directly. */
    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
    }

    private static ParseTenants(raw: string | undefined): string[]
    {
        if (raw === undefined)
        {
            return [];
        }
        return raw.split(IdpMain.TenantSeparator).map(t => t.trim()).filter(t => t !== '');
    }

    private static ResolvePort(raw: string | undefined): number
    {
        if (raw === undefined || raw === '')
        {
            return IdpMain.DefaultPort;
        }
        const port = Number(raw);
        if (!Number.isInteger(port) || port < 0 || port > IdpMain.MaxPort)
        {
            throw new Error(IdpMain.BadPortPrefix + raw);
        }
        return port;
    }

    private static LoadOrCreateMasterKey(file: string): Buffer
    {
        if (existsSync(file))
        {
            const key = readFileSync(file);
            if (key.length !== IdpMain.MasterKeyBytes)
            {
                throw new Error(IdpMain.BadMasterKeyMessage);
            }
            return key;
        }
        const key = randomBytes(IdpMain.MasterKeyBytes);
        writeFileSync(file, key, { mode: IdpMain.KeyFileMode });
        return key;
    }
}
