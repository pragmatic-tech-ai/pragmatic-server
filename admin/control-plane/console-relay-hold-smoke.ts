/**
 * GATED live smoke for the in-hive console's desktop relay through its Ingress (G3: the Ingress WebSocket timeouts). OPERATOR-RUN
 * ONLY: NOT a *.test.ts, NOT part of `tsx --test` / `npm test`, never executed by CI, excluded from the tenant-admin build by its
 * `-smoke.ts` name. The controller runs it against a deployed in-hive console (plan Task 15).
 *
 * What the hold proves: the relay is held open and without calls for HoldSeconds (default 150) between two ListGraphs calls, and the
 * second call must still succeed with CloseCode() undefined. That is end-to-end evidence that a relay survives a long gap through
 * the real Ingress, which is what a user hits. It is NOT proof of the Ingress WebSocket timeout settings: the server pings every
 * 30 s (HeartbeatMs in tenant-auth/desktop-relay.ts) and the client auto-answers with a pong, so the hold is not wire-idle and any
 * nginx read/send timeout longer than 30 s (the 60 s default included) is reset by that traffic. The Ingress annotation and the
 * timeouts nginx actually renders are checked separately on the cluster (plan Task 15). If a timer did cut the socket, the second
 * call fails (the protocol rejects an in-flight call when the socket closes) or CloseCode() is set.
 *
 * Requires: a deployed in-hive console with its development CA trusted by node, the owner's email and password in files, the
 * Playwright Chromium browser. Run with:
 *
 *   NODE_EXTRA_CA_CERTS=<devCaFile> npx tsx admin/control-plane/console-relay-hold-smoke.ts --console https://console-<tenant>.<base>
 *       --environment <name> --owner-email-file <path> --password-file <path> [--hold-seconds 150]
 *
 * Steps: console lookup (tenantId), begin with a loopback redirect and a PKCE challenge, a real Chromium sign-in at the IdP (the
 * loopback captures code and state), complete, relay connect, ListGraphs, idle hold, ListGraphs + CloseCode() undefined, sign-out
 * (always). The email, password, token and code are read into memory only: never printed. Failures print the error NAME only.
 * Output is one PASS/FAIL line per step; exit code 1 on any FAIL (and on the usage line).
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { PragmaticClient } from '@pragmatic-tech-ai/pragmatic-protocol'
import { chromium } from 'playwright'
import { IdpLoginPage } from './idp-login-page.js'

/** Parsed command line. */
type SmokeOptions = { console: string; environment: string; ownerEmailFile: string; passwordFile: string; holdSeconds: number }

/** The code and state the IdP redirected the browser back to the loopback with. */
type Callback = { code: string; state: string; path: string }

/** A loopback listener that captures the one IdP redirect. */
type Loopback = { port: number; callback: Promise<Callback>; close(): void }

/** One JSON answer: status and the parsed body (undefined when empty or not JSON). */
type Answer = { status: number; body: Record<string, unknown> | undefined }

export class ConsoleRelayHoldSmoke
{
    private static readonly ConsoleFlag = '--console'
    private static readonly EnvironmentFlag = '--environment'
    private static readonly OwnerEmailFileFlag = '--owner-email-file'
    private static readonly PasswordFileFlag = '--password-file'
    private static readonly HoldSecondsFlag = '--hold-seconds'
    private static readonly DefaultHoldSeconds = 150
    private static readonly UsageMessage = 'usage: NODE_EXTRA_CA_CERTS=CAFILE npx tsx admin/control-plane/console-relay-hold-smoke.ts --console URL --environment NAME --owner-email-file PATH --password-file PATH [--hold-seconds N]'

    private static readonly ConsolePath = '/desktop/console'
    private static readonly BeginPath = '/desktop/sign-in/begin'
    private static readonly CompletePath = '/desktop/sign-in/complete'
    private static readonly SignOutPath = '/desktop/sign-out'
    private static readonly RelayPath = '/desktop/relay?environment='
    private static readonly RelayAction = '&action=contribute'
    private static readonly CallbackPath = '/pragmatic-desktop/callback'
    private static readonly Loopback = '127.0.0.1'
    private static readonly HttpScheme = 'http://'
    private static readonly WssScheme = 'wss://'
    private static readonly WsScheme = 'ws://'
    private static readonly Colon = ':'
    private static readonly MethodGet = 'GET'
    private static readonly MethodPost = 'POST'
    private static readonly HeaderContentType = 'content-type'
    private static readonly HeaderAuthorization = 'authorization'
    private static readonly JsonType = 'application/json'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly Utf8 = 'utf8'
    private static readonly Base64Url = 'base64url'
    private static readonly Sha256 = 'sha256'
    private static readonly VerifierBytes = 32
    private static readonly TenantIdKey = 'tenantId'
    private static readonly RedirectUriKey = 'redirectUri'
    private static readonly BindingChallengeKey = 'bindingChallenge'
    private static readonly BindingVerifierKey = 'bindingVerifier'
    private static readonly AuthorizeUrlKey = 'authorizeUrl'
    private static readonly TokenKey = 'token'
    private static readonly CodeKey = 'code'
    private static readonly StateKey = 'state'
    private static readonly StatusOk = 200
    private static readonly StatusNoContent = 204
    private static readonly RequestTimeoutMs = 15000
    private static readonly FormWaitMs = 60000
    private static readonly ReturnWaitMs = 60000
    private static readonly MsPerSecond = 1000
    private static readonly HostResolverFlag = '--host-resolver-rules='
    private static readonly MapPrefix = 'MAP '
    private static readonly MapSuffix = ' 127.0.0.1'
    private static readonly RuleSeparator = ','
    private static readonly TrailingSlashes = /\/+$/
    private static readonly HttpsProtocol = 'https:'
    private static readonly CallbackBody = 'signed in; you can close this tab'
    private static readonly ErrorEvent = 'error'

    private static readonly PassTag = 'PASS '
    private static readonly FailTag = 'FAIL '
    private static readonly DetailSep = ' -- '
    private static readonly StatusWord = 'status '
    private static readonly ErrorNameWord = 'error name '
    private static readonly CrashPrefix = 'smoke crashed, error name '
    private static readonly OverallPass = 'OVERALL PASS'
    private static readonly OverallFail = 'OVERALL FAIL'
    private static readonly CountWord = 'graphs '
    private static readonly CloseCodeWord = 'close code '
    private static readonly HoldWord = 'held idle for seconds '
    private static readonly CallbackTimedOut = 'the IdP redirect did not reach the loopback in time'
    private static readonly CallbackMismatch = 'the loopback callback path or state differs from what was sent; not completing'
    private static readonly Labels = {
        EmailFile: 'owner email file is readable',
        PasswordFile: 'password file is readable',
        Lookup:'console lookup (GET /desktop/console) answers 200 with a tenantId',
        Begin: 'begin returns 200 with an authorize URL',
        Browser: 'browser: IdP login form, then the loopback captured a code and state',
        Complete: 'complete returns 200 with a token',
        Connect: 'relay connect through the Ingress succeeds',
        FirstList: 'ListGraphs before the hold returns a list',
        Hold: 'relay held idle',
        SecondList: 'ListGraphs after the hold returns a list and CloseCode() is undefined',
        SignOut: 'sign-out returns 200 or 204',
    }

    private failed = false

    private constructor(private readonly options: SmokeOptions, private readonly ownerEmail: string, private readonly password: string)
    {
    }

    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
    }

    public static async Main(): Promise<void>
    {
        const S = ConsoleRelayHoldSmoke
        const options = S.ParseArgs(process.argv.slice(2))
        if (options === undefined)
        {
            console.log(S.UsageMessage)
            process.exit(1)
        }
        const ownerEmail = S.ReadInput(options.ownerEmailFile, S.Labels.EmailFile)
        const password = ownerEmail === undefined ? undefined : S.ReadInput(options.passwordFile, S.Labels.PasswordFile)
        const ok = ownerEmail !== undefined && password !== undefined && await new ConsoleRelayHoldSmoke(options, ownerEmail, password).Run()
        console.log(ok ? S.OverallPass : S.OverallFail)
        process.exit(ok ? 0 : 1)
    }

    /** Reads one input file; on failure prints a FAIL line naming the input and the error name (never the path's content), and returns undefined. */
    private static ReadInput(path: string, label: string): string | undefined
    {
        const S = ConsoleRelayHoldSmoke
        try
        {
            return readFileSync(path, S.Utf8).trim()
        }
        catch (err)
        {
            console.log(S.FailTag + label + S.DetailSep + S.ErrorNameWord + S.SafeName(err))
            return undefined
        }
    }

    private static ParseArgs(argv: readonly string[]): SmokeOptions | undefined
    {
        const S = ConsoleRelayHoldSmoke
        const consoleUrl = S.ArgValue(argv, S.ConsoleFlag)
        const environment = S.ArgValue(argv, S.EnvironmentFlag)
        const ownerEmailFile = S.ArgValue(argv, S.OwnerEmailFileFlag)
        const passwordFile = S.ArgValue(argv, S.PasswordFileFlag)
        if (consoleUrl === undefined || environment === undefined || ownerEmailFile === undefined || passwordFile === undefined)
        {
            return undefined
        }
        const hold = Number(S.ArgValue(argv, S.HoldSecondsFlag) ?? S.DefaultHoldSeconds)
        if (!Number.isFinite(hold) || hold < 0)
        {
            return undefined
        }
        return { console: consoleUrl.replace(S.TrailingSlashes, ''), environment, ownerEmailFile, passwordFile, holdSeconds: hold }
    }

    private static ArgValue(argv: readonly string[], flag: string): string | undefined
    {
        const i = argv.indexOf(flag)
        return i >= 0 ? argv[i + 1] : undefined
    }

    /** Only the error class name is ever printed: messages can quote request or secret material. */
    private static SafeName(err: unknown): string
    {
        return err instanceof Error ? err.name : typeof err
    }

    private static Sleep(ms: number): Promise<void>
    {
        return new Promise<void>(resolve => setTimeout(resolve, ms))
    }

    public async Run(): Promise<boolean>
    {
        const S = ConsoleRelayHoldSmoke
        let token: string | undefined
        try
        {
            token = await this.SignedInToken()
            if (token !== undefined)
            {
                await this.HoldRelay(token)
            }
        }
        catch (err)
        {
            this.failed = true
            console.log(S.CrashPrefix + S.SafeName(err))
        }
        finally
        {
            if (token !== undefined)
            {
                await this.SignOut(token)
            }
        }
        return !this.failed
    }

    /** Console lookup, begin, the browser sign-in, complete; the session token, or undefined after a reported FAIL. */
    private async SignedInToken(): Promise<string | undefined>
    {
        const S = ConsoleRelayHoldSmoke
        const lookup = await this.PostOrGet(S.MethodGet, S.ConsolePath)
        const tenantId = lookup.body?.[S.TenantIdKey]
        this.Expect(S.Labels.Lookup, lookup.status === S.StatusOk && typeof tenantId === 'string', S.StatusWord + String(lookup.status))
        if (lookup.status !== S.StatusOk || typeof tenantId !== 'string')
        {
            return undefined
        }

        const verifier = randomBytes(S.VerifierBytes).toString(S.Base64Url)
        const challenge = createHash(S.Sha256).update(verifier).digest(S.Base64Url)
        const loopback = await this.OpenLoopback()
        try
        {
            const redirectUri = S.HttpScheme + S.Loopback + S.Colon + String(loopback.port) + S.CallbackPath
            const begin = await this.PostOrGet(S.MethodPost, S.BeginPath, { [S.TenantIdKey]: tenantId, [S.RedirectUriKey]: redirectUri, [S.BindingChallengeKey]: challenge })
            const authorizeUrl = begin.body?.[S.AuthorizeUrlKey]
            this.Expect(S.Labels.Begin, begin.status === S.StatusOk && typeof authorizeUrl === 'string', S.StatusWord + String(begin.status))
            if (begin.status !== S.StatusOk || typeof authorizeUrl !== 'string')
            {
                return undefined
            }

            const captured = await this.DriveBrowser(authorizeUrl, loopback)
            const sentState = new URL(authorizeUrl).searchParams.get(S.StateKey)
            const matches = captured !== undefined && captured.path === S.CallbackPath && sentState !== null && captured.state === sentState
            this.Expect(S.Labels.Browser, matches, captured === undefined ? S.CallbackTimedOut : S.CallbackMismatch)
            if (captured === undefined || !matches)
            {
                return undefined
            }

            const complete = await this.PostOrGet(S.MethodPost, S.CompletePath, { [S.StateKey]: captured.state, [S.CodeKey]: captured.code, [S.BindingVerifierKey]: verifier })
            const token = complete.body?.[S.TokenKey]
            const ok = complete.status === S.StatusOk && typeof token === 'string' && token.length > 0
            this.Expect(S.Labels.Complete, ok, S.StatusWord + String(complete.status))
            return ok ? token as string : undefined
        }
        finally
        {
            loopback.close()
        }
    }

    /** Real Chromium sign-in at the IdP; the loopback receives the redirect. Undefined when the redirect never arrived. */
    private async DriveBrowser(authorizeUrl: string, loopback: Loopback): Promise<Callback | undefined>
    {
        const S = ConsoleRelayHoldSmoke
        // Chromium maps the console and IdP hosts to the local ingress (the dev CA is not in the user's store), as in-hive-console-smoke.ts.
        const hosts = [new URL(this.options.console).hostname, new URL(authorizeUrl).hostname]
        const rules = S.HostResolverFlag + hosts.map(h => S.MapPrefix + h + S.MapSuffix).join(S.RuleSeparator)
        const browser = await chromium.launch({ args: [rules] })
        try
        {
            const context = await browser.newContext({ ignoreHTTPSErrors: true })
            const page = await context.newPage()
            await page.goto(authorizeUrl)
            await IdpLoginPage.WaitForForm(page, S.FormWaitMs)
            await IdpLoginPage.Submit(page, this.ownerEmail, this.password)
            let timer: NodeJS.Timeout | undefined
            const timeout = new Promise<undefined>(resolve =>
            {
                timer = setTimeout(() => resolve(undefined), S.ReturnWaitMs)
            })
            try
            {
                return await Promise.race<Callback | undefined>([loopback.callback, timeout])
            }
            finally
            {
                clearTimeout(timer)
            }
        }
        finally
        {
            await browser.close()
        }
    }

    /** Relay connect, the first call, the idle hold, the second call. */
    private async HoldRelay(token: string): Promise<void>
    {
        const S = ConsoleRelayHoldSmoke
        const origin = new URL(this.options.console)
        const url = (origin.protocol === S.HttpsProtocol ? S.WssScheme : S.WsScheme) + origin.host
            + S.RelayPath + encodeURIComponent(this.options.environment) + S.RelayAction
        let client: PragmaticClient
        try
        {
            client = await PragmaticClient.ConnectAsync(url, { bearerToken: token })
        }
        catch (err)
        {
            this.Expect(S.Labels.Connect, false, S.ErrorNameWord + S.SafeName(err))
            return
        }
        this.Expect(S.Labels.Connect, true)
        try
        {
            const first = await this.TryList(client)
            this.Expect(S.Labels.FirstList, first.count !== undefined, first.detail)
            if (first.count === undefined)
            {
                return
            }
            await S.Sleep(this.options.holdSeconds * S.MsPerSecond)
            this.Expect(S.Labels.Hold, true, S.HoldWord + String(this.options.holdSeconds))
            const second = await this.TryList(client)
            const code = client.CloseCode()
            this.Expect(S.Labels.SecondList, second.count !== undefined && code === undefined, second.detail + S.DetailSep + S.CloseCodeWord + String(code))
        }
        finally
        {
            await client.DisposeAsync()
        }
    }

    /** One ListGraphs: the graph count, or undefined with the error name. */
    private async TryList(client: PragmaticClient): Promise<{ count: number | undefined; detail: string }>
    {
        const S = ConsoleRelayHoldSmoke
        try
        {
            const graphs = await client.ListGraphs()
            return Array.isArray(graphs) ? { count: graphs.length, detail: S.CountWord + String(graphs.length) } : { count: undefined, detail: S.CountWord + String(graphs) }
        }
        catch (err)
        {
            return { count: undefined, detail: S.ErrorNameWord + S.SafeName(err) }
        }
    }

    /** Always runs once a token exists. */
    private async SignOut(token: string): Promise<void>
    {
        const S = ConsoleRelayHoldSmoke
        try
        {
            const out = await this.PostOrGet(S.MethodPost, S.SignOutPath, undefined, token)
            this.Expect(S.Labels.SignOut, out.status === S.StatusOk || out.status === S.StatusNoContent, S.StatusWord + String(out.status))
        }
        catch (err)
        {
            this.Expect(S.Labels.SignOut, false, S.ErrorNameWord + S.SafeName(err))
        }
    }

    /** A request to the console origin with node fetch (no Origin header, as a desktop client). */
    private async PostOrGet(method: string, path: string, body?: unknown, token?: string): Promise<Answer>
    {
        const S = ConsoleRelayHoldSmoke
        const headers: Record<string, string> = {}
        if (body !== undefined)
        {
            headers[S.HeaderContentType] = S.JsonType
        }
        if (token !== undefined)
        {
            headers[S.HeaderAuthorization] = S.BearerPrefix + token
        }
        const response = await fetch(this.options.console + path, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(S.RequestTimeoutMs),
        })
        const text = await response.text()
        return { status: response.status, body: ConsoleRelayHoldSmoke.ParseJson(text) }
    }

    private static ParseJson(text: string): Record<string, unknown> | undefined
    {
        try
        {
            return text.length === 0 ? undefined : JSON.parse(text) as Record<string, unknown>
        }
        catch
        {
            return undefined
        }
    }

    /** node:http on 127.0.0.1, port 0: answers the IdP redirect and resolves its code and state. */
    private OpenLoopback(): Promise<Loopback>
    {
        const S = ConsoleRelayHoldSmoke
        return new Promise((resolve, reject) =>
        {
            let deliver: (value: Callback) => void = () => undefined
            const callback = new Promise<Callback>(r =>
            {
                deliver = r
            })
            const server: Server = createServer((req, res) =>
            {
                const url = new URL(req.url ?? '', S.HttpScheme + S.Loopback)
                const code = url.searchParams.get(S.CodeKey)
                const state = url.searchParams.get(S.StateKey)
                res.end(S.CallbackBody)
                if (code !== null && state !== null)
                {
                    deliver({ code, state, path: url.pathname })
                }
            })
            server.once(S.ErrorEvent, reject)
            server.listen(0, S.Loopback, () => resolve({ port: (server.address() as AddressInfo).port, callback, close: () => server.close() }))
        })
    }

    private Expect(label: string, ok: boolean, detail: string = ''): void
    {
        const S = ConsoleRelayHoldSmoke
        if (!ok)
        {
            this.failed = true
        }
        console.log((ok ? S.PassTag : S.FailTag) + label + (detail !== '' ? S.DetailSep + detail : ''))
    }
}

if (ConsoleRelayHoldSmoke.IsEntryPoint())
{
    await ConsoleRelayHoldSmoke.Main()
}
