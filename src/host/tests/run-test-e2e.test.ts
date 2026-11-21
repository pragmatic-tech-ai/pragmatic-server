import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { AppDataProtocol, AppWriteOpKind, AppWriteStatus, ErrorCodes, GraphProtocol, NullLogger, RunTestProtocol, WebSocketMessageReader, WebSocketMessageWriter, WsMessageSocket, createMessageConnection, type AppWriteParams, type CypherAppDeployParamsDto, type MessageConnection } from '@pragmatic-tech-ai/pragmatic-protocol'
import { Repository, toJSON, type PackageDocument } from '@pragmatic-tech-ai/todl'
import { Grant, ResourceKind, ResourceRef, Role, TokenScope } from '@pragmatic-tech-ai/pragmatic-identity'
import { PragmaticServerHost } from '../pragmatic-server-host.js'
import { InMemoryEnvironmentProvisioning } from '../../environments/environment-registry.js'
import { EnvironmentPurpose } from '../../environments/environment-purpose.js'
import type { EnvironmentProvisioning } from '../../environments/environment-provisioning.js'
import { ProvisionedSecretSource } from '../../config/provisioned-secret-source.js'

/**
 * A dual-purpose environment (Development + runtimeCoHosted, with identity) on a real host: a Developer+RunTest token loads a
 * servable app through runtime/run-test, the app is served to a cookie session, and the same connection stays out of the data plane.
 */
class RunTestE2eFixture
{
    /** Mirrors the (private) message ServerConnectionHandler rejects out-of-scope methods with. */
    public static readonly OutsideScopeMessage = "method is outside this credential's scope"
    public static readonly App = 'shop'
    public static readonly Version = '1.0.0'
    public static readonly Entry = 'index.html'
    public static readonly Asset = 'assets/app.js'
    private static readonly Base64 = 'base64'
    private static readonly AssetBody = 'console.log(1)'
    public static readonly Shell = '<html><head></head><body>shell</body></html>'
    public static readonly OkStatus = 200
    public static readonly SignInStatus = 302
    private static readonly KeyEnv = 'PS_RUN_TEST_E2E_KEY'
    private static readonly EnvironmentId = 't1'
    private static readonly DisplayName = 'Environment One'
    private static readonly AdminEmail = 'admin@t1.test'
    private static readonly AdminPrincipal = 'admin'
    private static readonly AdminPasswordRef = 't1-admin-pw'
    private static readonly AdminPassword = 'admin-pw-12345'
    private static readonly DeveloperPrincipal = 'developer'
    private static readonly DirPrefix = 'ps-run-test-e2e-'
    private static readonly Loopback = '127.0.0.1'
    private static readonly Namespace = 'shop.core'
    private static readonly Concept = 'Order'
    private static readonly RowId = 'o1'
    private static readonly PackageVersion = '1.0.0'
    private static readonly BrowserLoginPath = '/auth/browser-login?environment=t1'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly JsonType = 'application/json'
    private static readonly PostMethod = 'POST'
    private static readonly CookieHeader = 'cookie'
    private static readonly SetCookieHeader = 'set-cookie'
    private static readonly OpenEvent = 'open'
    private static readonly ErrorEvent = 'error'
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly NoCookieMessage = 'browser-login set no session cookie'
    private static readonly CookieSeparator = ';'

    public readonly Dir = mkdtempSync(join(tmpdir(), RunTestE2eFixture.DirPrefix))
    public Host!: PragmaticServerHost
    private readonly connections: MessageConnection[] = []

    public static AppPath(): string
    {
        return `/app/${RunTestE2eFixture.EnvironmentId}/${RunTestE2eFixture.App}/`
    }

    public static Params(): CypherAppDeployParamsDto
    {
        const repo = new Repository()
        repo.builder().defineConcept(RunTestE2eFixture.Concept).setNamespace(RunTestE2eFixture.Namespace).commit()
        const document = toJSON(repo) as PackageDocument
        return {
            appName: RunTestE2eFixture.App,
            appVersion: RunTestE2eFixture.Version,
            packages: [{ id: RunTestE2eFixture.Namespace, version: RunTestE2eFixture.PackageVersion, modelJson: JSON.stringify(document) }],
            uiBundle: [
                { path: RunTestE2eFixture.Entry, contentBase64: Buffer.from(RunTestE2eFixture.Shell).toString(RunTestE2eFixture.Base64) },
                { path: RunTestE2eFixture.Asset, contentBase64: Buffer.from(RunTestE2eFixture.AssetBody).toString(RunTestE2eFixture.Base64) },
            ],
            manifest: {
                name: RunTestE2eFixture.App,
                version: RunTestE2eFixture.Version,
                packages: [{ id: RunTestE2eFixture.Namespace, version: RunTestE2eFixture.PackageVersion }],
                ui: { entry: RunTestE2eFixture.Entry, assets: [RunTestE2eFixture.Asset] },
            },
        }
    }

    /** A well-formed write: only the scope gate can reject it. */
    public static WriteParams(): AppWriteParams
    {
        return { operations: [{ op: AppWriteOpKind.Create, concept: RunTestE2eFixture.Concept, id: RunTestE2eFixture.RowId, fields: {} }] }
    }

    public async StartAsync(): Promise<void>
    {
        process.env[RunTestE2eFixture.KeyEnv] = randomBytes(32).toString('base64')
        const entries = new Map<string, EnvironmentProvisioning>([[RunTestE2eFixture.EnvironmentId, {
            displayName: RunTestE2eFixture.DisplayName,
            purpose: EnvironmentPurpose.Development,
            runtimeCoHosted: true,
            bootstrap: { adminEmail: RunTestE2eFixture.AdminEmail, adminPrincipalId: RunTestE2eFixture.AdminPrincipal, adminPasswordRef: RunTestE2eFixture.AdminPasswordRef, ownerGrant: true },
        }]])
        this.Host = await PragmaticServerHost.StartAsync({
            host: RunTestE2eFixture.Loopback,
            port: 0,
            baseDir: this.Dir,
            masterKey: { base64Env: RunTestE2eFixture.KeyEnv },
            provisioning: new InMemoryEnvironmentProvisioning(entries),
            provisionedSecrets: ProvisionedSecretSource.FromText(JSON.stringify({ [RunTestE2eFixture.AdminPasswordRef]: RunTestE2eFixture.AdminPassword })),
        })
    }

    public Base(): string
    {
        const address = this.Host.Address()
        return `http://${address.host}:${address.port}`
    }

    /** A connection under a Developer + RunTest token, minted as the admin RunTest relay mints it (Developer grant, run-test scope). */
    public async ConnectRunTestAsync(): Promise<MessageConnection>
    {
        const pack = await this.Host.IdentityPackForTest(RunTestE2eFixture.EnvironmentId)
        const realm = await this.Host.RealmForTest(RunTestE2eFixture.EnvironmentId)
        await pack.Grants.Save(new Grant(RunTestE2eFixture.DeveloperPrincipal, Role.Developer, new ResourceRef(ResourceKind.Realm, RunTestE2eFixture.EnvironmentId, [])))
        const issued = await pack.Tokens.Issue(realm, RunTestE2eFixture.DeveloperPrincipal, [TokenScope.RunTest], null)
        const address = this.Host.Address()
        const ws = new WebSocket(`ws://${address.host}:${address.port}/?environment=${RunTestE2eFixture.EnvironmentId}`, { headers: { [RunTestE2eFixture.AuthorizationHeader]: RunTestE2eFixture.BearerPrefix + issued.Token } })
        await new Promise<void>((resolve, reject) =>
        {
            ws.once(RunTestE2eFixture.OpenEvent, () => resolve())
            ws.once(RunTestE2eFixture.ErrorEvent, reject)
        })
        const socket = new WsMessageSocket(ws)
        const connection = createMessageConnection(new WebSocketMessageReader(socket), new WebSocketMessageWriter(socket), NullLogger)
        connection.listen()
        this.connections.push(connection)
        return connection
    }

    /** The name=value pair of a browser-login session cookie for the bootstrapped admin. */
    public async CookieAsync(): Promise<string>
    {
        const response = await fetch(this.Base() + RunTestE2eFixture.BrowserLoginPath, {
            method: RunTestE2eFixture.PostMethod,
            headers: { [RunTestE2eFixture.ContentTypeHeader]: RunTestE2eFixture.JsonType },
            body: JSON.stringify({ email: RunTestE2eFixture.AdminEmail, password: RunTestE2eFixture.AdminPassword }),
        })
        assert.equal(response.status, RunTestE2eFixture.OkStatus)
        const setCookie = response.headers.get(RunTestE2eFixture.SetCookieHeader)
        assert.ok(setCookie !== null, RunTestE2eFixture.NoCookieMessage)
        return setCookie.split(RunTestE2eFixture.CookieSeparator)[0]!
    }

    public GetAsync(path: string, cookie?: string): Promise<Response>
    {
        return fetch(this.Base() + path, { redirect: 'manual', headers: cookie === undefined ? {} : { [RunTestE2eFixture.CookieHeader]: cookie } })
    }

    public async DisposeAsync(): Promise<void>
    {
        for (const connection of this.connections)
        {
            connection.dispose()
        }
        await this.Host.DisposeAsync()
        rmSync(this.Dir, { recursive: true, force: true })
        delete process.env[RunTestE2eFixture.KeyEnv]
    }
}

test('a Developer+RunTest connection loads an app into the dual-purpose env, the app is served, and the data plane stays closed', async () =>
{
    const fx = new RunTestE2eFixture()
    await fx.StartAsync()
    try
    {
        const connection = await fx.ConnectRunTestAsync()
        const result = await connection.sendRequest(RunTestProtocol.Load, RunTestE2eFixture.Params())
        assert.equal(result.status, AppWriteStatus.Applied, result.reason)
        assert.equal(result.appName, RunTestE2eFixture.App)
        assert.equal(result.appVersion, RunTestE2eFixture.Version)

        const loaded = await connection.sendRequest(GraphProtocol.Loaded)
        assert.ok(loaded === null || Array.isArray(loaded.packages), 'graph/loaded is answered on the run-test connection')

        const anonymous = await fx.GetAsync(RunTestE2eFixture.AppPath())
        assert.equal(anonymous.status, RunTestE2eFixture.SignInStatus, 'a page load without a session is sent to sign-in')
        const shell = await fx.GetAsync(RunTestE2eFixture.AppPath(), await fx.CookieAsync())
        assert.equal(shell.status, RunTestE2eFixture.OkStatus)
        assert.ok((await shell.text()).includes(`<meta name="pragmatic-app" content="${RunTestE2eFixture.App}">`))

        await assert.rejects(() => connection.sendRequest(AppDataProtocol.Write, RunTestE2eFixture.WriteParams()), (e: { code?: number; message?: string }) => e.code === ErrorCodes.InvalidRequest && e.message === RunTestE2eFixture.OutsideScopeMessage)
    }
    finally
    {
        await fx.DisposeAsync()
    }
})
