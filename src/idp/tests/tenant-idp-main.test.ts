import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppliedConfiguration, AppliedConfigurationCodec } from '@pragmatic-tech-ai/pragmatic-configuration';
import { Realm, RealmKind, RealmIssuer } from '@pragmatic-tech-ai/pragmatic-identity';
import { Argon2PasswordHasher } from '@pragmatic-tech-ai/pragmatic-identity-source-local';
import { FileIdentityStores } from '@pragmatic-tech-ai/pragmatic-identity-store';
import { PgSession } from '@pragmatic-tech-ai/pragmatic-realm-adapters';
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing';
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node';
import { IdpMain } from '../idp-main.js';
import { TenantIdpComponent } from '../tenant-idp-component.js';
import { TenantIdpDatabase, TenantIdpDatabaseMissingError } from '../tenant-idp-database.js';
import type { TenantIdpService } from '../tenant-idp-service.js';

class MainFixture
{
    public static readonly DirPrefix = 'tenant-idp-main-';
    public static readonly BaseUrl = 'https://localhost';
    public static readonly Loopback = '127.0.0.1';
    public static readonly AdminRef = 'admin-token';
    public static readonly AdminToken = 'main-admin-token-xyz';
    public static readonly LoginIndex = '<html><head><meta name="pragmatic-login" content="ready"></head></html>';
    public static readonly Dirs: string[] = [];

    public static Dir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), MainFixture.DirPrefix));
        MainFixture.Dirs.push(dir);
        return dir;
    }

    /** A data folder, a minimal sign-in app and the base environment (TLS off: plain http on loopback). */
    public static Env(extra: NodeJS.ProcessEnv = {}): { env: NodeJS.ProcessEnv; data: string }
    {
        const data = MainFixture.Dir();
        const login = MainFixture.Dir();
        writeFileSync(join(login, 'index.html'), MainFixture.LoginIndex);
        return {
            data,
            env: {
                PRAGMATIC_IDP_BASE_URL: MainFixture.BaseUrl,
                PRAGMATIC_IDP_DATA: data,
                PRAGMATIC_IDP_LOGIN_DIR: login,
                PRAGMATIC_IDP_TLS: 'false',
                PRAGMATIC_IDP_CONFIGURATION_DIR: join(data, 'no-configuration'),
                ...extra,
            },
        };
    }

    public static Database(): TenantIdpDatabase
    {
        return TenantIdpDatabase.Over(new PgSession(SqlTestSessions.MemPool()));
    }

    public static async Get(service: TenantIdpService, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }>
    {
        await service.Listen(0, MainFixture.Loopback);
        const port = service.Address().port;
        try
        {
            return await new Promise((resolve, reject) =>
            {
                const req = httpRequest({ host: MainFixture.Loopback, port, path, headers: { host: 'localhost', ...headers } }, res =>
                {
                    const chunks: Buffer[] = [];
                    res.on('data', (c: Buffer) => chunks.push(c));
                    res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
                });
                req.on('error', reject);
                req.end();
            });
        }
        finally
        {
            await service.Close();
        }
    }
}

describe('IdpMain composition', () =>
{
    after(() =>
    {
        for (const dir of MainFixture.Dirs)
        {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('requires an https base URL and a database URL setting', async () =>
    {
        await assert.rejects(IdpMain.Compose({}), /PRAGMATIC_IDP_BASE_URL is required/);
        await assert.rejects(IdpMain.Compose({ PRAGMATIC_IDP_BASE_URL: 'http://localhost' }), /must be a valid https URL/);
        const { env } = MainFixture.Env();
        await assert.rejects(IdpMain.Compose(env), TenantIdpDatabaseMissingError);
    });

    it('serves its health and no admin API without an admin token file', async () =>
    {
        const { env } = MainFixture.Env();
        const service = await IdpMain.Compose(env, MainFixture.Database());
        assert.equal((await MainFixture.Get(service, '/healthz')).status, 200);
        const again = await IdpMain.Compose(env, MainFixture.Database());
        assert.equal((await MainFixture.Get(again, '/_admin/realms/tenant-1', { authorization: 'Bearer ' + MainFixture.AdminToken })).status, 404);
    });

    it('opens the admin API with the tokens of the referenced file', async () =>
    {
        const { env, data } = MainFixture.Env({ PRAGMATIC_IDP_ADMIN_TOKEN_REF: MainFixture.AdminRef });
        mkdirSync(join(data, 'secrets'), { recursive: true });
        writeFileSync(join(data, 'secrets', MainFixture.AdminRef), MainFixture.AdminToken + '\n');
        const db = MainFixture.Database();
        const service = await IdpMain.Compose(env, db);
        await service.Listen(0, MainFixture.Loopback);
        const port = service.Address().port;
        const status = await new Promise<number>((resolve, reject) =>
        {
            const req = httpRequest({ host: MainFixture.Loopback, port, path: '/_admin/realms/tenant-1', method: 'PUT', headers: { host: 'localhost', authorization: 'Bearer ' + MainFixture.AdminToken, 'content-type': 'application/json' } }, res =>
            {
                res.resume();
                res.on('end', () => resolve(res.statusCode ?? 0));
            });
            req.on('error', reject);
            req.end('{"displayName":"Tenant One"}');
        });
        await service.Close();
        assert.equal(status, 200);
    });

    it('reads a bootstrap realm and an applied configuration, each validated, and serves both realms', async () =>
    {
        const { env, data } = MainFixture.Env();
        const configurationDir = join(data, 'configuration');
        mkdirSync(configurationDir, { recursive: true });
        const descriptor = TenantIdpComponent.Descriptor();
        const applied = new AppliedConfiguration('tenant-7', TenantIdpComponent.Name, 3, descriptor.Version, descriptor.ContentDigest(), { options: { local: {}, tokens: { idTokenLifetime: '2m' } } });
        writeFileSync(join(configurationDir, 'configuration.json'), AppliedConfigurationCodec.Encode(applied));
        const bootstrap = join(data, 'central.json');
        writeFileSync(bootstrap, JSON.stringify({ realm: 'central', displayName: 'Pragmatic', configuration: { options: { local: { maxAttempts: 3 } } } }));
        const service = await IdpMain.Compose({ ...env, PRAGMATIC_IDP_CONFIGURATION_DIR: configurationDir, PRAGMATIC_IDP_BOOTSTRAP_REALM_FILE: bootstrap }, MainFixture.Database());
        assert.deepEqual(service.Realms.All().map(realm => realm.Id).sort(), ['central', 'tenant-7']);
        assert.equal(service.Realms.For('tenant-7')?.Settings.Tokens.IdTokenSeconds, 120);
        assert.equal(service.Realms.For('central')?.Settings.Local?.MaxAttempts, 3);
        assert.equal(service.Realms.For('central')?.DisplayName, 'Pragmatic');
        const discovery = await MainFixture.Get(service, '/realms/central' + RealmIssuer.DiscoveryPath);
        assert.equal(JSON.parse(discovery.body).issuer, 'https://localhost/realms/central');
    });

    it('refuses a configuration validated against another descriptor, and a bootstrap that does not validate', async () =>
    {
        const { env, data } = MainFixture.Env();
        const configurationDir = join(data, 'configuration');
        mkdirSync(configurationDir, { recursive: true });
        const stale = new AppliedConfiguration('tenant-7', TenantIdpComponent.Name, 1, '0.0.9', 'sha256:' + '0'.repeat(64), { options: {} });
        writeFileSync(join(configurationDir, 'configuration.json'), AppliedConfigurationCodec.Encode(stale));
        await assert.rejects(IdpMain.Compose({ ...env, PRAGMATIC_IDP_CONFIGURATION_DIR: configurationDir }, MainFixture.Database()), /validated against descriptor/);
        const bootstrap = join(data, 'bad.json');
        writeFileSync(bootstrap, JSON.stringify({ realm: 'central', configuration: { options: { google: { clientId: 'x', clientSecret: 'literal-secret' } } } }));
        await assert.rejects(IdpMain.Compose({ ...env, PRAGMATIC_IDP_BOOTSTRAP_REALM_FILE: bootstrap }, MainFixture.Database()), /does not validate/);
    });

    it('resolves a bootstrap realm\'s secret references through the file store', async () =>
    {
        const { env, data } = MainFixture.Env();
        const secrets = join(data, 'realm-secrets');
        mkdirSync(secrets, { recursive: true });
        writeFileSync(join(secrets, 'gip-browser-key'), 'AIza-test-key\n');
        const bootstrap = join(data, 'central.json');
        writeFileSync(bootstrap, JSON.stringify({ realm: 'central', configuration: { options: { identityPlatform: { projectId: 'pragmatic-identity', apiKey: 'secret:file/gip-browser-key' } } } }));
        const service = await IdpMain.Compose({ ...env, PRAGMATIC_IDP_BOOTSTRAP_REALM_FILE: bootstrap, PRAGMATIC_IDP_SECRETS_DIR: secrets }, MainFixture.Database());
        const page = service.Realms.For('central')?.IdentityPlatform?.PageConfig();
        assert.equal(page?.ApiKey, 'AIza-test-key');
        assert.equal(page?.ProjectId, 'pragmatic-identity');
        const discovery = JSON.parse((await MainFixture.Get(service, '/realms/central' + RealmIssuer.DiscoveryPath)).body);
        assert.deepEqual(discovery.prompt_values_supported, ['none', 'login', 'create']);
    });

    it('refuses to mint a new master key over a database that holds realms', async () =>
    {
        const { env, data } = MainFixture.Env();
        const db = MainFixture.Database();
        const bootstrap = join(data, 'central.json');
        writeFileSync(bootstrap, JSON.stringify({ realm: 'central', configuration: { options: { local: {} } } }));
        await IdpMain.Compose({ ...env, PRAGMATIC_IDP_BOOTSTRAP_REALM_FILE: bootstrap }, db);
        rmSync(join(data, 'master.key'));
        await assert.rejects(IdpMain.Compose(env, db), /master key file is missing/);
    });

    it('imports the pre-A5 file data once: realms, accounts with their passwords, clients; the files stay as they were', async () =>
    {
        const { env, data } = MainFixture.Env();
        const masterKey = Buffer.alloc(32, 3);
        writeFileSync(join(data, 'master.key'), masterKey);
        const realmDir = join(data, 'realms', 'tenant-1');
        mkdirSync(realmDir, { recursive: true });
        writeFileSync(join(data, 'realms', 'realm-catalog.json'), JSON.stringify({ 'tenant-1': 'Tenant One' }));
        const files = await FileIdentityStores.Open(new NodeFsStorage(realmDir), masterKey);
        const hasher = new Argon2PasswordHasher();
        await files.Secrets.Put('idp-password/p-1', await hasher.Hash('old password'));
        await files.Accounts.CreateAccount(new Realm('tenant-1', RealmKind.SelfHosted, 'tenant-1'), 'old@example.com', 'p-1', 'idp-password/p-1');
        writeFileSync(join(realmDir, 'idp-profiles.json'), JSON.stringify({ 'p-1': 'Old Timer' }));
        writeFileSync(join(data, 'clients.json'), JSON.stringify([{ clientId: 'console', tenantId: 'tenant-1', redirectUris: ['https://console.example/cb'], secretHash: await hasher.Hash('client secret') }]));
        const before = readFileSync(join(data, 'clients.json'), 'utf8');
        const db = MainFixture.Database();
        const service = await IdpMain.Compose(env, db);
        const realm = service.Realms.For('tenant-1');
        assert.equal(realm?.DisplayName, 'Tenant One');
        const signIn = await realm?.AuthenticatePassword('old@example.com', 'old password');
        assert.equal(signIn?.AccountId, 'p-1');
        assert.equal(signIn?.Name, 'Old Timer');
        assert.notEqual(await service.Stores.Clients.Authenticate('tenant-1', 'console', 'client secret'), undefined);
        assert.equal(readFileSync(join(data, 'clients.json'), 'utf8'), before);
        await realm?.ResetPassword('p-1', 'newer password');
        const again = await IdpMain.Compose(env, db);
        assert.equal(await again.Realms.For('tenant-1')?.AuthenticatePassword('old@example.com', 'old password'), undefined, 'a second start does not import again');
    });

    it('serves TLS itself unless told not to', async () =>
    {
        const { env, data } = MainFixture.Env({ PRAGMATIC_IDP_TLS: '' });
        const service = await IdpMain.Compose(env, MainFixture.Database());
        await service.Listen(0, MainFixture.Loopback);
        const port = service.Address().port;
        const ca = readFileSync(join(data, 'tls', 'ca.crt'), 'utf8');
        const status = await new Promise<number>((resolve, reject) =>
        {
            const req = httpsRequest({ host: 'localhost', port, path: '/healthz', ca }, res =>
            {
                res.resume();
                res.on('end', () => resolve(res.statusCode ?? 0));
            });
            req.on('error', reject);
            req.end();
        });
        await service.Close();
        assert.equal(status, 200);
    });
});
