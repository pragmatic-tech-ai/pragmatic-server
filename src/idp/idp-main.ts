import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComponentDescriptorCodec, type ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component';
import { DevCa, IdpTlsMaterial } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc';
import { IdpLoginPage } from './idp-login-page.js';
import { IdpSigningKey } from './idp-signing-key.js';
import { IdpTlsIdentity } from './idp-tls-identity.js';
import { RealmConfigurationReader, type RealmConfiguration } from './realm-configuration-reader.js';
import { TenantIdpComponent } from './tenant-idp-component.js';
import { TenantIdpDatabase } from './tenant-idp-database.js';
import { TenantIdpImport } from './tenant-idp-import.js';
import { SqlIdpRealmCatalogue } from './sql-idp-realm-catalogue.js';
import { TenantIdpSecretsHome, TenantIdpService } from './tenant-idp-service.js';

/**
 * Env-driven launcher of the realm sign-in service (`pragmatic-tenant-idp`). The secret files (signing key, master key,
 * TLS, admin tokens) live in the data folder; every record lives in the service's own Postgres; the realms'
 * configurations are read at start (applied configuration files and the bootstrap realm file).
 */
export class IdpMain
{
    private static readonly PortEnvVar = 'PRAGMATIC_IDP_PORT';
    private static readonly BaseUrlEnvVar = 'PRAGMATIC_IDP_BASE_URL';
    private static readonly InternalUrlEnvVar = 'PRAGMATIC_IDP_INTERNAL_URL';
    private static readonly HostEnvVar = 'PRAGMATIC_IDP_HOST';
    private static readonly DataEnvVar = 'PRAGMATIC_IDP_DATA';
    private static readonly SecureCookieEnvVar = 'PRAGMATIC_IDP_SECURE_COOKIE';
    private static readonly TlsEnvVar = 'PRAGMATIC_IDP_TLS';
    private static readonly TrustedProxyEnvVar = 'PRAGMATIC_IDP_TRUSTED_PROXY';
    private static readonly AdminTokenRefEnvVar = 'PRAGMATIC_IDP_ADMIN_TOKEN_REF';
    private static readonly ConfigurationDirEnvVar = 'PRAGMATIC_IDP_CONFIGURATION_DIR';
    private static readonly BootstrapRealmEnvVar = 'PRAGMATIC_IDP_BOOTSTRAP_REALM_FILE';
    private static readonly SecretsDirEnvVar = 'PRAGMATIC_IDP_SECRETS_DIR';
    private static readonly ApplicationsDirEnvVar = 'PRAGMATIC_IDP_APPLICATIONS_DIR';
    // Where the built sign-in app lives; defaults to idp-login/dist beside this package.
    private static readonly LoginDirEnvVar = 'PRAGMATIC_IDP_LOGIN_DIR';
    private static readonly DefaultConfigurationDir = '/etc/pragmatic/configuration';
    private static readonly LineBreak = /\r?\n/;
    private static readonly SecretsDir = 'secrets';
    private static readonly CurrentDir = '.';
    private static readonly ParentDir = '..';
    private static readonly Utf8 = 'utf8';
    private static readonly NotFoundCode = 'ENOENT';
    private static readonly JsonSuffix = '.json';
    private static readonly DefaultPort = 7100;
    private static readonly MaxPort = 65535;
    private static readonly DefaultHost = '127.0.0.1';
    private static readonly DataDir = 'data';
    private static readonly SigningKeyFile = 'signing-key.pem';
    private static readonly MasterKeyFile = 'master.key';
    private static readonly TlsDir = 'tls';
    private static readonly MasterKeyBytes = 32;
    private static readonly KeyFileMode = 0o600;
    private static readonly FalseToken = 'false';
    private static readonly ZeroToken = '0';
    private static readonly TrueToken = 'true';
    private static readonly OneToken = '1';
    private static readonly MissingBaseUrlMessage = 'PRAGMATIC_IDP_BASE_URL is required (an https origin)';
    private static readonly BadBaseUrlMessage = 'PRAGMATIC_IDP_BASE_URL must be a valid https URL';
    private static readonly BadInternalUrlMessage = 'PRAGMATIC_IDP_INTERNAL_URL must be a valid https URL';
    private static readonly HttpsProtocol = 'https:';
    private static readonly FailPrefix = 'pragmatic-idp failed to start: ';
    private static readonly FailExitCode = 1;
    private static readonly BadPortPrefix = 'Invalid PRAGMATIC_IDP_PORT: ';
    private static readonly BadMasterKeyMessage = 'IdP master key file must be exactly 32 bytes';
    private static readonly MissingMasterKeyMessage = 'the IdP master key file is missing but the database already holds realms (restore master.key; a new key cannot open their secrets)';
    private static readonly ListeningPrefix = 'pragmatic-idp listening on ';

    public static async Run(): Promise<void>
    {
        const service = await IdpMain.Compose(process.env);
        const bind = process.env[IdpMain.HostEnvVar] ?? IdpMain.DefaultHost;
        const port = IdpMain.ResolvePort(process.env[IdpMain.PortEnvVar]);
        await service.Listen(port, bind);
        console.log(IdpMain.ListeningPrefix + process.env[IdpMain.BaseUrlEnvVar]);
    }

    /** Builds every collaborator from the environment and returns a not-yet-listening service. */
    public static async Compose(env: NodeJS.ProcessEnv, database?: TenantIdpDatabase): Promise<TenantIdpService>
    {
        const M = IdpMain;
        const baseUrl = env[M.BaseUrlEnvVar];
        if (baseUrl === undefined || baseUrl === '')
        {
            throw new Error(M.MissingBaseUrlMessage);
        }
        M.RequireHttps(baseUrl, M.BadBaseUrlMessage);
        const rawInternal = env[M.InternalUrlEnvVar];
        const internalBaseUrl = rawInternal === undefined || rawInternal === '' ? undefined : rawInternal;
        if (internalBaseUrl !== undefined)
        {
            M.RequireHttps(internalBaseUrl, M.BadInternalUrlMessage);
        }
        const data = env[M.DataEnvVar] ?? join(dirname(fileURLToPath(import.meta.url)), M.DataDir);
        mkdirSync(data, { recursive: true });
        const signingKey = await IdpSigningKey.LoadOrCreate(join(data, M.SigningKeyFile));
        const adminTokens = M.LoadAdminTokens(data, env[M.AdminTokenRefEnvVar]);
        const db = database ?? await TenantIdpDatabase.Open(env);
        const masterKeyFile = join(data, M.MasterKeyFile);
        // A new master key over a database that holds realms would leave every sealed secret unreadable: refuse instead.
        if (!existsSync(masterKeyFile) && (await (await SqlIdpRealmCatalogue.Open(db.Session)).Entries()).length > 0)
        {
            throw new Error(M.MissingMasterKeyMessage);
        }
        const masterKey = M.LoadOrCreateMasterKey(masterKeyFile);
        // Pre-A5 file data (realms, accounts, clients under the data folder) moves into the database once.
        await TenantIdpImport.ImportIfPending(db, data, masterKey);
        const secretsDir = M.Optional(env[M.SecretsDirEnvVar]);
        const reader = new RealmConfigurationReader(TenantIdpComponent.Descriptor(), new TenantIdpSecretsHome(db, masterKey, secretsDir));
        const configurations: RealmConfiguration[] = [...await reader.ReadDirectory(M.Optional(env[M.ConfigurationDirEnvVar]) ?? M.DefaultConfigurationDir)];
        const bootstrap = M.Optional(env[M.BootstrapRealmEnvVar]);
        if (bootstrap !== undefined)
        {
            configurations.push(await reader.ReadBootstrap(bootstrap));
        }
        const tlsOn = !M.IsOff(env[M.TlsEnvVar]);
        let tls: IdpTlsIdentity | undefined;
        if (tlsOn)
        {
            const ca = DevCa.EnsureAt(join(data, M.TlsDir), new URL(baseUrl).hostname);
            const material = IdpTlsMaterial.Load({ certFile: ca.certFile, keyFile: ca.keyFile });
            tls = new IdpTlsIdentity(material.key, material.cert);
        }
        // The built sign-in app is required: Load throws (the daemon refuses to start) when it is missing.
        return await TenantIdpService.Open({
            Database: db,
            SigningKey: signingKey,
            MasterKey: masterKey,
            BaseUrl: baseUrl,
            InternalBaseUrl: internalBaseUrl,
            Configurations: RealmConfigurationReader.Unique(configurations),
            Applications: M.ReadApplications(M.Optional(env[M.ApplicationsDirEnvVar])),
            LoginPage: IdpLoginPage.Load(env[M.LoginDirEnvVar] || IdpLoginPage.DefaultRoot()),
            SecureCookie: !M.IsOff(env[M.SecureCookieEnvVar]),
            TrustedProxy: M.IsOn(env[M.TrustedProxyEnvVar]),
            Tls: tls,
            AdminTokens: adminTokens,
        });
    }

    /** Prints a concise startup failure (message only, no stack) and sets a non-zero exit code. */
    public static Fail(err: unknown): void
    {
        console.error(IdpMain.FailPrefix + (err instanceof Error ? err.message : String(err)));
        process.exitCode = IdpMain.FailExitCode;
    }

    /** True when this module is the process entry point (not when imported by tests); the bin starts Run directly. */
    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
    }

    /** Every component descriptor (`*.json`) of the folder; none when it is unset or absent. */
    private static ReadApplications(directory: string | undefined): ComponentDescriptor[]
    {
        if (directory === undefined || !existsSync(directory))
        {
            return [];
        }
        return readdirSync(directory)
            .filter(name => name.endsWith(IdpMain.JsonSuffix))
            .sort()
            .map(name => ComponentDescriptorCodec.Parse(readFileSync(join(directory, name), IdpMain.Utf8)));
    }

    /**
     * Reads the admin token SET from `<data>/secrets/<ref>`: newline-separated, each trimmed, blanks dropped (a single
     * line is a set of one). Fail-closed: an unset ref, a missing file, or no non-blank token all mean admin is
     * disabled (undefined). No token is ever logged or put in an error.
     */
    private static LoadAdminTokens(data: string, ref: string | undefined): string[] | undefined
    {
        if (ref === undefined || ref === '')
        {
            return undefined;
        }
        if (basename(ref) !== ref || ref === IdpMain.CurrentDir || ref === IdpMain.ParentDir)
        {
            return undefined;
        }
        let raw: string;
        try
        {
            raw = readFileSync(join(data, IdpMain.SecretsDir, ref), IdpMain.Utf8);
        }
        catch (err)
        {
            if ((err as NodeJS.ErrnoException).code === IdpMain.NotFoundCode)
            {
                return undefined;
            }
            throw err;
        }
        const tokens = raw.split(IdpMain.LineBreak).map(line => line.trim()).filter(line => line !== '');
        return tokens.length === 0 ? undefined : tokens;
    }

    private static RequireHttps(baseUrl: string, message: string): void
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
            throw new Error(message);
        }
    }

    private static Optional(raw: string | undefined): string | undefined
    {
        return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
    }

    private static IsOff(raw: string | undefined): boolean
    {
        return raw === IdpMain.FalseToken || raw === IdpMain.ZeroToken;
    }

    private static IsOn(raw: string | undefined): boolean
    {
        return raw === IdpMain.TrueToken || raw === IdpMain.OneToken;
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
