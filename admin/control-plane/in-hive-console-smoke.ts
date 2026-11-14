/**
 * GATED live smoke for the in-hive tenant console on a local kind cluster (default `kind-pragmatic-dev`; see SmokeCluster). OPERATOR-RUN ONLY: NOT a *.test.ts, NOT part of
 * `tsx --test` / `npm test`, never executed by CI, excluded from the tenant-admin build by its `-smoke.ts` name.
 *
 * Requires: a control plane running from this checkout (operator API on --control-plane, agent channel on), hive
 * `default-pragmatic-hive` (tenant `pragmatic-default`) with its agent connected on that context, a FRESH
 * `pragmatic-server:dev` image in the host docker store (the smoke streams it into the cluster's node), an ingress answering on
 * 127.0.0.1:443 (the dev cluster maps no host port, since dev-up's Caddy holds :443: use a cluster created with a :443 mapping,
 * e.g. the live-loop stack's `kind-pragmatic-e2e`, or Docker Desktop's `docker-desktop`),
 * openssl on PATH, and the Playwright Chromium browser. Desktop discovery must answer, so the control plane needs a tenant-plane URL
 * (PRAGMATIC_DESKTOP_TENANT_PLANE_URL, or both PRAGMATIC_TENANT_ADMIN_PORT and PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN); without one
 * discovery answers 503 and the smoke stops at its discovery preflight. The console reaches the agent channel at the control plane's
 * agent-channel URL (default http://host.docker.internal:<PRAGMATIC_AGENT_CHANNEL_PORT>). Run with:
 *
 *   npx tsx admin/control-plane/in-hive-console-smoke.ts --operator-email admin@control-plane.test --password-file <path>
 *       [--hive default-pragmatic-hive] [--base-domain localtest.me] [--control-plane http://127.0.0.1:7000]
 *
 * Steps: preflight (+ ingress-nginx when no `nginx` IngressClass exists), operator login, console settings with development TLS,
 * console install to `deployed`, TLS handshake against the development CA, a fresh Owner password, a real Chromium sign-in at
 * the console through the in-hive IdP, environment create + delete from the console, then teardown (always). The operator and
 * Owner passwords are read into memory only: never printed, logged or put in an exception. Output is one PASS/FAIL line per
 * step; exit code 1 on any FAIL.
 *
 * Advert + discovery steps (Plan 2): a discovery preflight with a throwaway address (404 or 200; 503 names the env var above);
 * 3b the in-hive tenant is left out of discovery before its console advertised; 4b the install status turns `reported`; 4c the
 * Owner's email discovers the in-hive console; 7b the Owner sets an email domain in the console; 7c the operator sees it
 * (source console, read-only, PUT 409); 7d an advertised but unapproved domain does not discover the tenant, an operator
 * approval makes it discover the in-hive console, a revoke stops it; the teardown checks the advert was forgotten. Discovery
 * is called with node http (no Origin) at most MaxDiscoverCalls times, under its throttle of 10 per minute per address. The
 * Owner email is read from the operator API and never printed (it is scrubbed like a secret).
 */
import { readFileSync } from 'node:fs'
import { SmokeCluster } from './smoke-cluster.js'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { TLSSocket } from 'node:tls'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Page } from 'playwright'
import { IdpLoginPage } from './idp-login-page.js'
import { K8sManifestBuilder } from './k8s-manifest-builder.js'
import { KindImageLoader } from './kind-image-loader.js'
import { KubectlError, NodeExecFile } from './kubectl.js'

/** Parsed command line. */
type SmokeOptions = { operatorEmail: string; passwordFile: string; hiveId: string; baseDomain: string; controlPlane: string }

/** One operator API answer: status, parsed JSON body (or undefined) and the Set-Cookie values. */
type ApiAnswer = { status: number; body: Record<string, unknown> | undefined; setCookie: string[] }

/** One in-page fetch answer from the console origin. */
type PageAnswer = { status: number; text: string }

export class InHiveConsoleSmoke
{
    private static readonly Context = SmokeCluster.Context()
    private static readonly TenantId = 'pragmatic-default'
    private static readonly DefaultHive = 'default-pragmatic-hive'
    private static readonly DefaultBaseDomain = 'localtest.me'
    private static readonly DefaultControlPlane = 'http://127.0.0.1:7000'
    private static readonly Image = 'pragmatic-server:dev'
    private static readonly EnvName = 'smoke-ihc'
    private static readonly EnvTemplate = 'dev-blank'
    private static readonly EnvType = 'development'

    private static readonly EmailFlag = '--operator-email'
    private static readonly PasswordFileFlag = '--password-file'
    private static readonly HiveFlag = '--hive'
    private static readonly BaseDomainFlag = '--base-domain'
    private static readonly ControlPlaneFlag = '--control-plane'
    private static readonly UsageMessage = 'usage: npx tsx admin/control-plane/in-hive-console-smoke.ts --operator-email EMAIL --password-file PATH [--hive ID] [--base-domain DOMAIN] [--control-plane URL]'

    private static readonly Kubectl = 'kubectl'
    private static readonly ContextFlag = '--context'
    private static readonly NamespaceFlag = '-n'
    private static readonly GetVerb = 'get'
    private static readonly ApplyVerb = 'apply'
    private static readonly DeleteVerb = 'delete'
    private static readonly RolloutVerb = 'rollout'
    private static readonly StatusVerb = 'status'
    private static readonly WaitVerb = 'wait'
    private static readonly FileFlag = '-f'
    private static readonly OutputFlag = '-o'
    private static readonly Json = 'json'
    private static readonly NameOutput = 'name'
    private static readonly IgnoreNotFound = '--ignore-not-found'
    private static readonly NamespaceKind = 'namespace'
    private static readonly SecretKind = 'secret'
    private static readonly PvcKind = 'pvc'
    private static readonly RoleBindingKind = 'rolebinding'
    private static readonly IngressClassKind = 'ingressclass'
    private static readonly ClusterRoleKind = 'clusterroles'
    private static readonly AdmissionPolicyKind = 'validatingadmissionpolicies'
    private static readonly AdmissionBindingKind = 'validatingadmissionpolicybindings'
    private static readonly JobKind = 'job'
    private static readonly AllFlag = '--all'
    private static readonly DeploymentPrefix = 'deployment/'
    private static readonly CompleteCondition = '--for=condition=complete'
    private static readonly IngressTimeout = '--timeout=300s'
    private static readonly EnvRolloutTimeout = '--timeout=300s'
    private static readonly NginxClass = 'nginx'
    private static readonly IngressNamespace = 'ingress-nginx'
    private static readonly IngressDeployment = 'ingress-nginx-controller'
    private static readonly IngressManifestUrl = 'https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/cloud/deploy.yaml'
    private static readonly HiveLabel = 'pragmatic/hive'
    private static readonly PodSecurityEnforceLabel = 'pod-security.kubernetes.io/enforce'
    private static readonly PodSecurityBaseline = 'baseline'
    private static readonly ClusterRolePrefix = 'clusterrole.rbac.authorization.k8s.io/'
    private static readonly NotFoundPattern = /NotFound|not found/i
    private static readonly KubectlTimeoutMs = 600000

    private static readonly ApiPrefix = '/api/hives/'
    private static readonly LoginPath = '/api/login'
    private static readonly ConsoleSuffix = '/console'
    private static readonly ConsoleInstallSuffix = '/console-install'
    private static readonly OwnerPasswordSuffix = '/console/owner-password'
    private static readonly MethodGet = 'GET'
    private static readonly MethodPost = 'POST'
    private static readonly MethodPut = 'PUT'
    private static readonly MethodDelete = 'DELETE'
    private static readonly ContentTypeHeader = 'content-type'
    private static readonly CookieHeader = 'cookie'
    private static readonly JsonType = 'application/json'
    private static readonly OperatorCookieName = 'cp_session'
    private static readonly CookieAssign = '='
    private static readonly CookieAttrSep = ';'
    private static readonly EmailKey = 'email'
    private static readonly PasswordKey = 'password'
    private static readonly StateKey = 'state'
    private static readonly StepKey = 'step'
    private static readonly ErrorKey = 'error'
    private static readonly DevCaFileKey = 'devCaFile'
    private static readonly OwnerEmailKey = 'ownerEmail'
    private static readonly OwnerPasswordKey = 'ownerPassword'
    private static readonly StateDeployed = 'deployed'
    private static readonly StateFailed = 'failed'
    private static readonly TlsDevelopment = 'development'
    private static readonly StatusOk = 200
    private static readonly StatusCreated = 201
    private static readonly StatusAccepted = 202
    private static readonly StatusRedirectFloor = 300
    private static readonly StatusRedirectCeiling = 400
    private static readonly StatusSuccessFloor = 200
    private static readonly PollIntervalMs = 2000
    private static readonly InstallDeadlineMs = 15 * 60 * 1000
    private static readonly NamespaceGoneDeadlineMs = 2 * 60 * 1000
    private static readonly TlsTimeoutMs = 30000
    private static readonly IngressSettleMs = 60000
    private static readonly StatusServerErrorFloor = 500
    private static readonly StatusNotFound = 404
    private static readonly StatusConflict = 409
    private static readonly StatusUnavailable = 503

    private static readonly TenantsPrefix = '/api/tenants/'
    private static readonly EmailDomainsSuffix = '/email-domains'
    private static readonly ApproveSuffix = '/email-domains/approve'
    private static readonly RevokeSuffix = '/email-domains/revoke'
    private static readonly DiscoverPath = '/api/desktop/discover'
    private static readonly ConsoleEmailDomainsPath = '/tenant-api/settings/email-domains'
    private static readonly SmokeDomain = 'smoke-ihc.test'
    private static readonly DomainEmail = 'someone@smoke-ihc.test'
    private static readonly ThrowawayEmail = 'nobody@smoke-ihc-discovery-preflight.test'
    private static readonly StateReported = 'reported'
    private static readonly ConsoleUrlKey = 'consoleUrl'
    private static readonly StaleKey = 'stale'
    private static readonly TenantsKey = 'tenants'
    private static readonly TenantPlaneUrlKey = 'tenantPlaneUrl'
    private static readonly IdKey = 'id'
    private static readonly DomainsKey = 'domains'
    private static readonly DomainKey = 'domain'
    private static readonly EditableKey = 'editable'
    private static readonly SourceKey = 'source'
    private static readonly ApprovalsKey = 'approvals'
    private static readonly ApprovedKey = 'approved'
    private static readonly SourceConsole = 'console'
    /** Discovery calls per run: preflight, 3b, 4c, three in 7d, one in the teardown; the throttle allows 10 per minute per address. */
    private static readonly MaxDiscoverCalls = 7
    private static readonly ReportPollIntervalMs = 5000
    private static readonly ReportDeadlineMs = 3 * 60 * 1000
    private static readonly DomainPollIntervalMs = 2000
    private static readonly DomainDeadlineMs = 60 * 1000
    private static readonly DataEvent = 'data'
    private static readonly EndEvent = 'end'

    private static readonly HttpsScheme = 'https://'
    private static readonly Loopback = '127.0.0.1'
    private static readonly HttpsPort = 443
    private static readonly RootPath = '/'
    private static readonly IssuerPrefix = 'Pragmatic Development CA ('
    private static readonly IssuerSuffix = ')'
    private static readonly TlsTimeoutMessage = 'TLS request timed out'
    private static readonly HostResolverFlag = '--host-resolver-rules='
    private static readonly MapPrefix = 'MAP '
    private static readonly MapSuffix = ' 127.0.0.1'
    private static readonly RuleSeparator = ','
    private static readonly EnvironmentsPath = '/tenant-api/environments'
    private static readonly ProfilePath = '/tenant-api/profile'
    private static readonly PathSeparator = '/'
    private static readonly SessionCookieName = 'pts_session'
    private static readonly FormWaitMs = 60000
    private static readonly ReturnWaitMs = 60000

    private static readonly PassTag = 'PASS '
    private static readonly FailTag = 'FAIL '
    private static readonly DetailSep = ' -- '
    private static readonly StatusWord = 'status '
    private static readonly Redacted = '[redacted]'
    private static readonly CrashPrefix = 'smoke crashed: '
    private static readonly OverallPass = 'OVERALL PASS'
    private static readonly OverallFail = 'OVERALL FAIL'
    private static readonly InstallTimedOut = 'install did not finish within 15 minutes; last step '
    private static readonly MissingCaFile = 'install status carries no devCaFile'
    private static readonly MissingOwner = 'response carries no ownerEmail/ownerPassword'
    private static readonly IssuerWord = 'issuer '
    private static readonly RemainingWord = 'remaining: '
    private static readonly NoneWord = 'none'
    private static readonly ListSep = ', '
    private static readonly IdpWord = 'idp '
    private static readonly SessionWord = ' session '
    private static readonly KindSeparator = ','
    private static readonly Utf8 = 'utf8'
    private static readonly TimeoutEvent = 'timeout'
    private static readonly ErrorEvent = 'error'
    private static readonly DiscoveryUnavailable = 'discovery answered 503: the control plane has no tenant-plane URL; set PRAGMATIC_DESKTOP_TENANT_PLANE_URL (or PRAGMATIC_TENANT_ADMIN_PORT and PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN) and restart it'
    private static readonly DiscoverCapExceeded = 'discover call cap exceeded (the throttle allows 10 per minute per address)'
    private static readonly MissingTenantOwner = 'tenant record carries no ownerEmail'
    private static readonly ReportTimedOut = 'install did not turn reported within 3 minutes; last state '
    private static readonly DomainTimedOut = 'the console-reported domain did not reach the operator report within 60 seconds'
    private static readonly ListedWord = 'listed '
    private static readonly ConsoleUrlWord = ' consoleUrl '
    private static readonly StaleWord = ' stale '
    private static readonly PlaneWord = ' tenantPlaneUrl '
    private static readonly Labels = {
        DiscoverPreflight: 'preflight: discovery answers (404 or 200) for a throwaway address',
        OwnerEmail: 'GET tenant returns the Owner email (not printed)',
        NoAdvertYet: 'discover(Owner) before the install leaves the in-hive tenant out',
        Reported: 'console-install turns reported with the console URL, not stale',
        DiscoverOwner: 'discover(Owner) returns the in-hive console URL; tenantPlaneUrl differs',
        ConsoleDomainPut: 'console: PUT /tenant-api/settings/email-domains returns 200 with the domain, editable',
        OperatorDomainSeen: 'operator: GET email-domains shows the console-reported domain (source console, read-only, unapproved)',
        OperatorDomainPut: 'operator: PUT email-domains on an in-hive tenant returns 409',
        UnapprovedDomain: 'discover(domain) while unapproved leaves the tenant out',
        ApproveDomain: 'operator: POST email-domains/approve returns 200 and marks the domain approved',
        ApprovedDomain: 'discover(domain) after approval returns the in-hive console URL',
        RevokeDomain: 'operator: POST email-domains/revoke returns 200 and clears the approval',
        RevokedDomain: 'discover(domain) after revoke leaves the tenant out',
        TeardownDomains: 'teardown: console email domains cleared (PUT empty list)',
        TeardownRevoke: 'teardown: domain approval revoked',
        AdvertForgotten: 'teardown: discover(Owner) no longer points at the in-hive console',
        Preflight: 'preflight: pragmatic-system and the hive agent token Secret exist',
        Ingress: 'preflight: ingress-nginx installed by the smoke and rolled out',
        IngressPresent: 'preflight: IngressClass nginx already present (not installed by the smoke)',
        Image: 'preflight: pragmatic-server:dev streamed into the smoke cluster node',
        Login: 'operator login returns 200 and a session cookie',
        Settings: 'PUT console settings (development TLS) returns 200',
        InstallStart: 'POST console-install returns 202',
        Deployed: 'console install reaches deployed',
        Tls: 'console TLS handshake verifies against the development CA (issuer CN matches)',
        OwnerPassword: 'POST console/owner-password returns 200 with ownerEmail + ownerPassword',
        SignIn: 'browser: IdP login form, then back on the console with a pts_session and a profile',
        EnvCreate: 'console: POST /tenant-api/environments returns 201',
        EnvLabels: 'env namespace carries the hive label and pod-security enforce=baseline',
        EnvBinding: 'env namespace has RoleBinding pragmatic-tenant-console',
        EnvReady: 'env server Deployment rolled out',
        EnvDelete: 'console: DELETE /tenant-api/environments/smoke-ihc returns 2xx',
        EnvGone: 'env namespace gone within 2 minutes',
        TeardownEnv: 'teardown: env namespace removed via kubectl',
        TeardownConsole: 'teardown: DELETE console returns 200',
        TeardownIdp: 'teardown: IdP namespace deleted',
        TeardownRetained: 'teardown: console data PVC and seed Secret deleted',
        TeardownIngress: 'teardown: ingress-nginx removed',
        NoClusterRoles: 'teardown: no pragmatic-tenant-admin-<tenant> ClusterRole remains',
        NoAdmission: 'teardown: no console admission policy or binding remains',
    }

    private failed = false
    private sessionCookie: string | undefined
    private installedIngress = false
    private envDeleted = false
    private envCreated = false
    private domainsSet = false
    private domainApproved = false
    private discoverCalls = 0
    private ownerEmail: string | undefined
    private readonly secrets: string[] = []
    private readonly exec = new NodeExecFile(InHiveConsoleSmoke.KubectlTimeoutMs)

    private constructor(private readonly options: SmokeOptions, private readonly operatorPassword: string)
    {
        this.secrets.push(operatorPassword)
    }

    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
    }

    public static async Main(): Promise<void>
    {
        const S = InHiveConsoleSmoke
        const options = S.ParseArgs(process.argv.slice(2))
        if (options === undefined)
        {
            console.log(S.UsageMessage)
            process.exit(1)
        }
        const password = readFileSync(options.passwordFile, S.Utf8).trim()
        const ok = await new InHiveConsoleSmoke(options, password).Run()
        console.log(ok ? S.OverallPass : S.OverallFail)
        process.exit(ok ? 0 : 1)
    }

    private static ParseArgs(argv: readonly string[]): SmokeOptions | undefined
    {
        const S = InHiveConsoleSmoke
        const email = S.ArgValue(argv, S.EmailFlag)
        const file = S.ArgValue(argv, S.PasswordFileFlag)
        if (email === undefined || file === undefined)
        {
            return undefined
        }
        return {
            operatorEmail: email,
            passwordFile: file,
            hiveId: S.ArgValue(argv, S.HiveFlag) ?? S.DefaultHive,
            baseDomain: S.ArgValue(argv, S.BaseDomainFlag) ?? S.DefaultBaseDomain,
            controlPlane: (S.ArgValue(argv, S.ControlPlaneFlag) ?? S.DefaultControlPlane).replace(/\/+$/, ''),
        }
    }

    private static ArgValue(argv: readonly string[], flag: string): string | undefined
    {
        const i = argv.indexOf(flag)
        return i >= 0 ? argv[i + 1] : undefined
    }

    public async Run(): Promise<boolean>
    {
        const S = InHiveConsoleSmoke
        try
        {
            await this.Preflight()
            if (!await this.Login())
            {
                return false
            }
            if (!await this.DiscoveryPreflight() || !await this.ReadOwnerEmail())
            {
                return false
            }
            if (!await this.Install())
            {
                return false
            }
            const owner = await this.OwnerPassword()
            if (owner === undefined)
            {
                return false
            }
            await this.DriveConsole(owner.email, owner.password)
        }
        catch (err)
        {
            this.failed = true
            console.log(S.CrashPrefix + this.Scrub(err))
        }
        finally
        {
            await this.Teardown()
        }
        return !this.failed
    }

    /** Step 1: the hive's system namespace and agent token exist; ingress-nginx is present (or installed here); the image is on the node. */
    private async Preflight(): Promise<void>
    {
        const S = InHiveConsoleSmoke
        await this.Kubectl([S.GetVerb, S.NamespaceKind, K8sManifestBuilder.SystemNamespace, S.OutputFlag, S.NameOutput])
        await this.Kubectl([S.GetVerb, S.SecretKind, K8sManifestBuilder.AgentTokenSecretNameOf(this.options.hiveId), S.NamespaceFlag, K8sManifestBuilder.SystemNamespace, S.OutputFlag, S.NameOutput])
        this.Expect(S.Labels.Preflight, true)

        const nginx = await this.Kubectl([S.GetVerb, S.IngressClassKind, S.NginxClass, S.IgnoreNotFound, S.OutputFlag, S.NameOutput])
        if (nginx.trim().length === 0)
        {
            await this.Kubectl([S.ApplyVerb, S.FileFlag, S.IngressManifestUrl])
            this.installedIngress = true
            await this.Kubectl([S.WaitVerb, S.NamespaceFlag, S.IngressNamespace, S.CompleteCondition, S.JobKind, S.AllFlag, S.IngressTimeout])
            await this.Kubectl([S.RolloutVerb, S.StatusVerb, S.DeploymentPrefix + S.IngressDeployment, S.NamespaceFlag, S.IngressNamespace, S.IngressTimeout])
            this.Expect(S.Labels.Ingress, true)
        }
        else
        {
            this.Expect(S.Labels.IngressPresent, true)
        }

        await new KindImageLoader(SmokeCluster.Node()).Load(S.Image)
        this.Expect(S.Labels.Image, true)
    }

    /** Step 2: operator login with Origin unset; keeps the session cookie. */
    private async Login(): Promise<boolean>
    {
        const S = InHiveConsoleSmoke
        const login = await this.Api(S.MethodPost, S.LoginPath, { [S.EmailKey]: this.options.operatorEmail, [S.PasswordKey]: this.operatorPassword })
        const prefix = S.OperatorCookieName + S.CookieAssign
        const pair = login.setCookie.map(c => c.split(S.CookieAttrSep)[0] as string).find(c => c.startsWith(prefix))
        this.Expect(S.Labels.Login, login.status === S.StatusOk && pair !== undefined, S.StatusWord + String(login.status))
        this.sessionCookie = pair
        return pair !== undefined
    }

    /** Discovery preflight: a throwaway address answers 404 or 200; a 503 means the control plane has no tenant-plane URL. */
    private async DiscoveryPreflight(): Promise<boolean>
    {
        const S = InHiveConsoleSmoke
        const answer = await this.Discover(S.ThrowawayEmail)
        const ok = answer.status === S.StatusNotFound || answer.status === S.StatusOk
        this.Expect(S.Labels.DiscoverPreflight, ok, answer.status === S.StatusUnavailable ? S.DiscoveryUnavailable : S.StatusWord + String(answer.status))
        return ok
    }

    /** The tenant's Owner email from the operator API; kept in memory and scrubbed from every output line. */
    private async ReadOwnerEmail(): Promise<boolean>
    {
        const S = InHiveConsoleSmoke
        const answer = await this.Api(S.MethodGet, this.TenantPath(''))
        const email = answer.body?.[S.OwnerEmailKey]
        const ok = answer.status === S.StatusOk && typeof email === 'string' && email.length > 0
        if (ok)
        {
            this.ownerEmail = email as string
            this.secrets.push(email as string)
        }
        this.Expect(S.Labels.OwnerEmail, ok, answer.status === S.StatusOk ? S.MissingTenantOwner : this.Detail(answer))
        return ok
    }

    /** Steps 3-5 (+3b, 4b, 4c): console settings, install to deployed, the TLS handshake, then the advert and Owner discovery. */
    private async Install(): Promise<boolean>
    {
        const S = InHiveConsoleSmoke
        const settings = await this.Api(S.MethodPut, this.HivePath(S.ConsoleSuffix), { baseDomain: this.options.baseDomain, tls: { source: S.TlsDevelopment } })
        this.Expect(S.Labels.Settings, settings.status === S.StatusOk, this.Detail(settings))
        if (settings.status !== S.StatusOk)
        {
            return false
        }
        const before = await this.Discover(this.ownerEmail as string)
        this.Expect(S.Labels.NoAdvertYet, before.status === S.StatusNotFound || (before.status === S.StatusOk && this.EntryOf(before) === undefined), this.DiscoverDetail(before))
        const start = await this.Api(S.MethodPost, this.HivePath(S.ConsoleInstallSuffix))
        this.Expect(S.Labels.InstallStart, start.status === S.StatusAccepted, this.Detail(start))
        if (start.status !== S.StatusAccepted)
        {
            return false
        }
        const status = await this.PollInstall()
        // The console's first advert can arrive during the rollout wait, so the first status seen after the run may already be reported.
        const deployed = status?.[S.StateKey] === S.StateDeployed || status?.[S.StateKey] === S.StateReported
        this.Expect(S.Labels.Deployed, deployed, deployed ? '' : this.InstallDetail(status))
        if (!deployed)
        {
            return false
        }
        const caFile = status?.[S.DevCaFileKey]
        if (typeof caFile !== 'string')
        {
            this.Expect(S.Labels.Tls, false, S.MissingCaFile)
            return false
        }
        const tls = await this.SettledTlsCheck(caFile)
        this.Expect(S.Labels.Tls, tls.ok, tls.detail)
        if (!tls.ok)
        {
            return false
        }
        return await this.CheckReported() && await this.CheckOwnerDiscovery()
    }

    /** Step 4b: the install status turns reported (the console advertised) with the console URL and not stale. */
    private async CheckReported(): Promise<boolean>
    {
        const S = InHiveConsoleSmoke
        const deadline = Date.now() + S.ReportDeadlineMs
        let last: Record<string, unknown> | undefined
        while (Date.now() < deadline)
        {
            last = (await this.Api(S.MethodGet, this.HivePath(S.ConsoleInstallSuffix))).body
            if (last?.[S.StateKey] === S.StateReported)
            {
                break
            }
            await InHiveConsoleSmoke.Sleep(S.ReportPollIntervalMs)
        }
        const reported = last?.[S.StateKey] === S.StateReported
        const ok = reported && last?.[S.ConsoleUrlKey] === this.ConsoleUrl() && last?.[S.StaleKey] === false
        this.Expect(S.Labels.Reported, ok, reported
            ? S.ConsoleUrlWord + String(last?.[S.ConsoleUrlKey]) + S.StaleWord + String(last?.[S.StaleKey])
            : S.ReportTimedOut + String(last?.[S.StateKey]))
        return ok
    }

    /** Step 4c: the Owner's email discovers the in-hive console; the top-level tenant-plane URL is a different string. */
    private async CheckOwnerDiscovery(): Promise<boolean>
    {
        const S = InHiveConsoleSmoke
        const answer = await this.Discover(this.ownerEmail as string)
        const plane = answer.body?.[S.TenantPlaneUrlKey]
        const ok = answer.status === S.StatusOk && this.EntryOf(answer)?.[S.ConsoleUrlKey] === this.ConsoleUrl()
            && typeof plane === 'string' && plane !== this.ConsoleUrl()
        this.Expect(S.Labels.DiscoverOwner, ok, this.DiscoverDetail(answer))
        return ok
    }

    /**
     * The controller serves a new Ingress a few seconds after it is admitted (config reload + endpoint sync), so a 5xx right after
     * the rollout is retried for up to a minute; a TLS failure or any other status is final.
     */
    private async SettledTlsCheck(caFile: string): Promise<{ ok: boolean; detail: string; status: number }>
    {
        const S = InHiveConsoleSmoke
        const deadline = Date.now() + S.IngressSettleMs
        let result = await this.TlsCheck(caFile)
        while (result.status >= S.StatusServerErrorFloor && Date.now() < deadline)
        {
            await InHiveConsoleSmoke.Sleep(S.PollIntervalMs)
            result = await this.TlsCheck(caFile)
        }
        return result
    }

    private async PollInstall(): Promise<Record<string, unknown> | undefined>
    {
        const S = InHiveConsoleSmoke
        const deadline = Date.now() + S.InstallDeadlineMs
        let last: Record<string, unknown> | undefined
        while (Date.now() < deadline)
        {
            const answer = await this.Api(S.MethodGet, this.HivePath(S.ConsoleInstallSuffix))
            last = answer.body
            const state = last?.[S.StateKey]
            if (state === S.StateDeployed || state === S.StateReported || state === S.StateFailed)
            {
                return last
            }
            await InHiveConsoleSmoke.Sleep(S.PollIntervalMs)
        }
        return { ...last, [S.ErrorKey]: S.InstallTimedOut + String(last?.[S.StepKey]) }
    }

    private InstallDetail(status: Record<string, unknown> | undefined): string
    {
        const S = InHiveConsoleSmoke
        return this.ScrubText(String(status?.[S.StateKey]) + S.DetailSep + String(status?.[S.StepKey]) + S.DetailSep + String(status?.[S.ErrorKey]))
    }

    /** Step 5: TLS to the ingress on 127.0.0.1:443 with SNI + Host = the console host, trusting only the development CA. */
    private TlsCheck(caFile: string): Promise<{ ok: boolean; detail: string; status: number }>
    {
        const S = InHiveConsoleSmoke
        const host = this.ConsoleHost()
        const ca = readFileSync(caFile)
        const expectedIssuer = S.IssuerPrefix + this.options.baseDomain + S.IssuerSuffix
        return new Promise(resolve =>
        {
            const req = httpsRequest({ host: S.Loopback, port: S.HttpsPort, path: S.RootPath, method: S.MethodGet, servername: host, headers: { host }, ca, timeout: S.TlsTimeoutMs }, res =>
            {
                const issuer = (res.socket as TLSSocket).getPeerCertificate().issuer?.CN
                const status = res.statusCode ?? 0
                res.resume()
                const statusOk = status === S.StatusOk || (status >= S.StatusRedirectFloor && status < S.StatusRedirectCeiling)
                resolve({ ok: statusOk && issuer === expectedIssuer, detail: S.StatusWord + String(status) + S.DetailSep + S.IssuerWord + String(issuer), status })
            })
            req.on(S.TimeoutEvent, () => req.destroy(new Error(S.TlsTimeoutMessage)))
            req.on(S.ErrorEvent, err => resolve({ ok: false, detail: this.Scrub(err), status: 0 }))
            req.end()
        })
    }

    /** Step 6: a fresh Owner password, kept in memory only. */
    private async OwnerPassword(): Promise<{ email: string; password: string } | undefined>
    {
        const S = InHiveConsoleSmoke
        const answer = await this.Api(S.MethodPost, this.HivePath(S.OwnerPasswordSuffix))
        const email = answer.body?.[S.OwnerEmailKey]
        const password = answer.body?.[S.OwnerPasswordKey]
        if (typeof password === 'string' && password.length > 0)
        {
            this.secrets.push(password)
        }
        const ok = answer.status === S.StatusOk && typeof email === 'string' && typeof password === 'string' && password.length > 0
        this.Expect(S.Labels.OwnerPassword, ok, answer.status === S.StatusOk ? S.MissingOwner : this.Detail(answer))
        return ok ? { email: email as string, password: password as string } : undefined
    }

    /** Steps 7-9: real Chromium sign-in at the console, then environment create + delete from the console's page. */
    private async DriveConsole(ownerEmail: string, ownerPassword: string): Promise<void>
    {
        const S = InHiveConsoleSmoke
        const host = this.ConsoleHost()
        const browser = await chromium.launch({ args: [this.HostResolverRules()] })
        let page: Page | undefined
        try
        {
            const context = await browser.newContext({ ignoreHTTPSErrors: true })
            page = await context.newPage()
            await page.goto(S.HttpsScheme + host + S.RootPath)
            await IdpLoginPage.WaitForForm(page, S.FormWaitMs)
            const onIdp = new URL(page.url()).host === K8sManifestBuilder.IdpBrowserHostOf(S.TenantId, this.options.baseDomain)
            await IdpLoginPage.Submit(page, ownerEmail, ownerPassword)
            await page.waitForURL(url => url.host === host, { timeout: S.ReturnWaitMs })
            const cookies = await context.cookies()
            const hasSession = cookies.some(c => c.name === S.SessionCookieName && c.value.length > 0)
            const profile = await this.PageFetch(page, S.MethodGet, S.ProfilePath)
            this.Expect(S.Labels.SignIn, onIdp && hasSession && profile.status === S.StatusOk,
                S.IdpWord + String(onIdp) + S.SessionWord + String(hasSession) + S.DetailSep + S.StatusWord + String(profile.status))
            if (profile.status !== S.StatusOk)
            {
                return
            }
            await this.DomainSteps(page)

            const create = await this.PageFetch(page, S.MethodPost, S.EnvironmentsPath, JSON.stringify({ name: S.EnvName, template: S.EnvTemplate, type: S.EnvType }))
            this.envCreated = true
            this.Expect(S.Labels.EnvCreate, create.status === S.StatusCreated, S.StatusWord + String(create.status) + S.DetailSep + this.ScrubText(create.text))
            if (create.status !== S.StatusCreated)
            {
                return
            }
            await this.CheckEnvironment()

            const remove = await this.PageFetch(page, S.MethodDelete, S.EnvironmentsPath + S.PathSeparator + encodeURIComponent(S.EnvName))
            const removed = remove.status >= S.StatusSuccessFloor && remove.status < S.StatusRedirectFloor
            this.Expect(S.Labels.EnvDelete, removed, S.StatusWord + String(remove.status) + S.DetailSep + this.ScrubText(remove.text))
            if (removed)
            {
                this.envDeleted = true
                this.Expect(S.Labels.EnvGone, await this.WaitNamespaceGone(K8sManifestBuilder.NamespaceOf(S.EnvName)))
            }
        }
        finally
        {
            if (page !== undefined)
            {
                await this.ClearConsoleDomains(page)
            }
            await browser.close()
        }
    }

    /**
     * Steps 7b-7d: the Owner sets a domain in the console; the operator sees it read-only and unapproved; discovery ignores it
     * until an operator approves it, then answers with the in-hive console, and ignores it again once revoked.
     */
    private async DomainSteps(page: Page): Promise<void>
    {
        const S = InHiveConsoleSmoke
        const put = await this.PageFetch(page, S.MethodPut, S.ConsoleEmailDomainsPath, JSON.stringify({ [S.DomainsKey]: [S.SmokeDomain] }))
        this.domainsSet = true
        const view = InHiveConsoleSmoke.ParseJson(put.text)
        const putOk = put.status === S.StatusOk && InHiveConsoleSmoke.SameList(view?.[S.DomainsKey], [S.SmokeDomain]) && view?.[S.EditableKey] === true
        this.Expect(S.Labels.ConsoleDomainPut, putOk, S.StatusWord + String(put.status) + S.DetailSep + this.ScrubText(put.text))
        if (!putOk)
        {
            return
        }

        const report = await this.PollOperatorDomain()
        const approval = this.ApprovalOf(report)
        const seen = report !== undefined && report[S.SourceKey] === S.SourceConsole && report[S.EditableKey] === false && approval?.[S.ApprovedKey] === false
        this.Expect(S.Labels.OperatorDomainSeen, seen, report === undefined ? S.DomainTimedOut : JSON.stringify(report))
        const refused = await this.Api(S.MethodPut, this.TenantPath(S.EmailDomainsSuffix), { [S.DomainsKey]: [S.SmokeDomain] })
        this.Expect(S.Labels.OperatorDomainPut, refused.status === S.StatusConflict, this.Detail(refused))
        if (!seen)
        {
            return
        }

        const unapproved = await this.Discover(S.DomainEmail)
        this.Expect(S.Labels.UnapprovedDomain, this.TenantLeftOut(unapproved), this.DiscoverDetail(unapproved))

        const approve = await this.Api(S.MethodPost, this.TenantPath(S.ApproveSuffix), { [S.DomainKey]: S.SmokeDomain })
        this.domainApproved = approve.status === S.StatusOk
        this.Expect(S.Labels.ApproveDomain, approve.status === S.StatusOk && this.ApprovalOf(approve.body)?.[S.ApprovedKey] === true, this.Detail(approve))
        if (!this.domainApproved)
        {
            return
        }
        const approved = await this.Discover(S.DomainEmail)
        this.Expect(S.Labels.ApprovedDomain, approved.status === S.StatusOk && this.EntryOf(approved)?.[S.ConsoleUrlKey] === this.ConsoleUrl(), this.DiscoverDetail(approved))

        const revoke = await this.Api(S.MethodPost, this.TenantPath(S.RevokeSuffix), { [S.DomainKey]: S.SmokeDomain })
        const revoked = revoke.status === S.StatusOk && this.ApprovalOf(revoke.body)?.[S.ApprovedKey] === false
        if (revoked)
        {
            this.domainApproved = false
        }
        this.Expect(S.Labels.RevokeDomain, revoked, this.Detail(revoke))
        const after = await this.Discover(S.DomainEmail)
        this.Expect(S.Labels.RevokedDomain, this.TenantLeftOut(after), this.DiscoverDetail(after))
    }

    /** Polls the operator report until the console-reported domain appears; the last report with it, or undefined at the deadline. */
    private async PollOperatorDomain(): Promise<Record<string, unknown> | undefined>
    {
        const S = InHiveConsoleSmoke
        const deadline = Date.now() + S.DomainDeadlineMs
        while (Date.now() < deadline)
        {
            const report = (await this.Api(S.MethodGet, this.TenantPath(S.EmailDomainsSuffix))).body
            const domains = report?.[S.DomainsKey]
            if (Array.isArray(domains) && domains.includes(S.SmokeDomain))
            {
                return report
            }
            await InHiveConsoleSmoke.Sleep(S.DomainPollIntervalMs)
        }
        return undefined
    }

    /** The report's approval entry for the smoke domain, if any. */
    private ApprovalOf(report: Record<string, unknown> | undefined): Record<string, unknown> | undefined
    {
        const S = InHiveConsoleSmoke
        const approvals = report?.[S.ApprovalsKey]
        if (!Array.isArray(approvals))
        {
            return undefined
        }
        return (approvals as Record<string, unknown>[]).find(a => a?.[S.DomainKey] === S.SmokeDomain)
    }

    /** Teardown part done in the page while it is open: PUT an empty domain list when 7b ran. */
    private async ClearConsoleDomains(page: Page): Promise<void>
    {
        const S = InHiveConsoleSmoke
        if (!this.domainsSet)
        {
            return
        }
        const cleared = await this.Attempt(async () =>
        {
            const answer = await this.PageFetch(page, S.MethodPut, S.ConsoleEmailDomainsPath, JSON.stringify({ [S.DomainsKey]: [] }))
            if (answer.status !== S.StatusOk)
            {
                throw new Error(S.StatusWord + String(answer.status))
            }
            return ''
        })
        this.Expect(S.Labels.TeardownDomains, cleared.ok, cleared.detail)
    }

    /** Step 8's cluster checks: labels (hive + PSA baseline), the console's RoleBinding, and the server rollout. */
    private async CheckEnvironment(): Promise<void>
    {
        const S = InHiveConsoleSmoke
        const ns = K8sManifestBuilder.NamespaceOf(S.EnvName)
        const doc = JSON.parse(await this.Kubectl([S.GetVerb, S.NamespaceKind, ns, S.OutputFlag, S.Json])) as { metadata?: { labels?: Record<string, string> } }
        const labels = doc.metadata?.labels ?? {}
        this.Expect(S.Labels.EnvLabels, labels[S.HiveLabel] === this.options.hiveId && labels[S.PodSecurityEnforceLabel] === S.PodSecurityBaseline, JSON.stringify(labels))
        const binding = await this.Kubectl([S.GetVerb, S.RoleBindingKind, K8sManifestBuilder.TenantConsoleEnvBindingName, S.NamespaceFlag, ns, S.IgnoreNotFound, S.OutputFlag, S.NameOutput])
        this.Expect(S.Labels.EnvBinding, binding.trim().length > 0)
        const ready = await this.Attempt(() => this.Kubectl([S.RolloutVerb, S.StatusVerb, S.DeploymentPrefix + K8sManifestBuilder.ServerDeploymentOf(S.EnvName), S.NamespaceFlag, ns, S.EnvRolloutTimeout]))
        this.Expect(S.Labels.EnvReady, ready.ok, ready.detail)
    }

    /** Step 10: always runs; each action best-effort and reported. */
    private async Teardown(): Promise<void>
    {
        const S = InHiveConsoleSmoke
        const tenant = S.TenantId
        if (this.envCreated && !this.envDeleted)
        {
            const env = await this.Attempt(() => this.Kubectl([S.DeleteVerb, S.NamespaceKind, K8sManifestBuilder.NamespaceOf(S.EnvName), S.IgnoreNotFound]))
            this.Expect(S.Labels.TeardownEnv, env.ok, env.detail)
        }
        if (this.domainApproved)
        {
            const revoked = await this.Attempt(async () =>
            {
                const answer = await this.Api(S.MethodPost, this.TenantPath(S.RevokeSuffix), { [S.DomainKey]: S.SmokeDomain })
                if (answer.status !== S.StatusOk)
                {
                    throw new Error(this.Detail(answer))
                }
                return ''
            })
            this.Expect(S.Labels.TeardownRevoke, revoked.ok, revoked.detail)
        }
        if (this.sessionCookie !== undefined)
        {
            const removed = await this.Attempt(async () =>
            {
                const answer = await this.Api(S.MethodDelete, this.HivePath(S.ConsoleSuffix))
                if (answer.status !== S.StatusOk)
                {
                    throw new Error(this.Detail(answer))
                }
                return ''
            })
            this.Expect(S.Labels.TeardownConsole, removed.ok, removed.detail)
            if (removed.ok && this.ownerEmail !== undefined)
            {
                await this.CheckAdvertForgotten(this.ownerEmail)
            }
        }
        const idp = await this.Attempt(() => this.Kubectl([S.DeleteVerb, S.NamespaceKind, K8sManifestBuilder.IdpNameOf(tenant), S.IgnoreNotFound]))
        this.Expect(S.Labels.TeardownIdp, idp.ok, idp.detail)
        const retained = await this.Attempt(async () =>
        {
            await this.Kubectl([S.DeleteVerb, S.PvcKind, K8sManifestBuilder.TenantAdminClaimNameOf(tenant), S.NamespaceFlag, K8sManifestBuilder.SystemNamespace, S.IgnoreNotFound])
            return this.Kubectl([S.DeleteVerb, S.SecretKind, K8sManifestBuilder.TenantAdminSeedSecretNameOf(tenant), S.NamespaceFlag, K8sManifestBuilder.SystemNamespace, S.IgnoreNotFound])
        })
        this.Expect(S.Labels.TeardownRetained, retained.ok, retained.detail)
        if (this.installedIngress)
        {
            const ingress = await this.Attempt(() => this.Kubectl([S.DeleteVerb, S.IgnoreNotFound, S.FileFlag, S.IngressManifestUrl]))
            this.Expect(S.Labels.TeardownIngress, ingress.ok, ingress.detail)
        }
        const roles = await this.Attempt(() => this.Kubectl([S.GetVerb, S.ClusterRoleKind, S.OutputFlag, S.NameOutput]))
        const prefix = S.ClusterRolePrefix + K8sManifestBuilder.TenantAdminNameOf(tenant)
        const left = roles.detail.split(/\r?\n/).filter(l => l.startsWith(prefix))
        this.Expect(S.Labels.NoClusterRoles, roles.ok && left.length === 0, S.RemainingWord + (left.length === 0 ? S.NoneWord : left.join(S.ListSep)))
        const policy = K8sManifestBuilder.TenantAdminNameOf(tenant)
        const policies = await this.Attempt(() => this.Kubectl([S.GetVerb, S.AdmissionPolicyKind + S.KindSeparator + S.AdmissionBindingKind, S.OutputFlag, S.NameOutput]))
        const fences = policies.detail.split(/\r?\n/).filter(l => l.endsWith(S.PathSeparator + policy))
        this.Expect(S.Labels.NoAdmission, policies.ok && fences.length === 0, S.RemainingWord + (fences.length === 0 ? S.NoneWord : fences.join(S.ListSep)))
    }

    /** Teardown: after the console removal the advert is forgotten, so an Owner match (if any) points at the tenant plane. */
    private async CheckAdvertForgotten(ownerEmail: string): Promise<void>
    {
        const S = InHiveConsoleSmoke
        const answer = await this.Discover(ownerEmail)
        const entry = this.EntryOf(answer)
        const ok = answer.status === S.StatusNotFound
            || (answer.status === S.StatusOk && (entry === undefined || entry[S.ConsoleUrlKey] === answer.body?.[S.TenantPlaneUrlKey]))
        this.Expect(S.Labels.AdvertForgotten, ok, this.DiscoverDetail(answer))
    }

    /**
     * POST /api/desktop/discover with node http and no Origin header (a desktop client). Counted against MaxDiscoverCalls so a
     * run stays under the endpoint's per-address throttle; past the cap the call is not made and answers status 0.
     */
    private async Discover(email: string): Promise<ApiAnswer>
    {
        const S = InHiveConsoleSmoke
        if (this.discoverCalls >= S.MaxDiscoverCalls)
        {
            this.Expect(S.DiscoverCapExceeded, false)
            return { status: 0, body: undefined, setCookie: [] }
        }
        this.discoverCalls++
        const url = new URL(this.options.controlPlane + S.DiscoverPath)
        const payload = JSON.stringify({ [S.EmailKey]: email })
        return new Promise((resolve, reject) =>
        {
            const req = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname, method: S.MethodPost, headers: { [S.ContentTypeHeader]: S.JsonType } }, res =>
            {
                const chunks: Buffer[] = []
                res.on(S.DataEvent, (c: Buffer) => chunks.push(c))
                res.on(S.EndEvent, () => resolve({ status: res.statusCode ?? 0, body: InHiveConsoleSmoke.ParseJson(Buffer.concat(chunks).toString(S.Utf8)), setCookie: [] }))
                res.on(S.ErrorEvent, reject)
            })
            req.on(S.ErrorEvent, reject)
            req.end(payload)
        })
    }

    /** The discovery answer's entry for the smoke tenant, if listed. */
    private EntryOf(answer: ApiAnswer): Record<string, unknown> | undefined
    {
        const S = InHiveConsoleSmoke
        const tenants = answer.body?.[S.TenantsKey]
        if (!Array.isArray(tenants))
        {
            return undefined
        }
        return (tenants as Record<string, unknown>[]).find(t => t?.[S.IdKey] === S.TenantId)
    }

    /** 404, or 200 without the smoke tenant. */
    private TenantLeftOut(answer: ApiAnswer): boolean
    {
        const S = InHiveConsoleSmoke
        return answer.status === S.StatusNotFound || (answer.status === S.StatusOk && this.EntryOf(answer) === undefined)
    }

    /** Status, whether the smoke tenant is listed, its consoleUrl and the tenant-plane URL; never the email asked about. */
    private DiscoverDetail(answer: ApiAnswer): string
    {
        const S = InHiveConsoleSmoke
        const entry = this.EntryOf(answer)
        return S.StatusWord + String(answer.status) + S.DetailSep + S.ListedWord + String(entry !== undefined)
            + S.ConsoleUrlWord + String(entry?.[S.ConsoleUrlKey]) + S.PlaneWord + String(answer.body?.[S.TenantPlaneUrlKey])
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

    private static SameList(value: unknown, expected: readonly string[]): boolean
    {
        return Array.isArray(value) && value.length === expected.length && value.every((v, i) => v === expected[i])
    }

    private async WaitNamespaceGone(namespace: string): Promise<boolean>
    {
        const S = InHiveConsoleSmoke
        const deadline = Date.now() + S.NamespaceGoneDeadlineMs
        while (Date.now() < deadline)
        {
            const found = await this.Kubectl([S.GetVerb, S.NamespaceKind, namespace, S.IgnoreNotFound, S.OutputFlag, S.NameOutput])
            if (found.trim().length === 0)
            {
                return true
            }
            await InHiveConsoleSmoke.Sleep(S.PollIntervalMs)
        }
        return false
    }

    /** fetch() from inside the console page, so the browser sends its own session cookie and Origin. */
    private async PageFetch(page: Page, method: string, path: string, body?: string): Promise<PageAnswer>
    {
        return page.evaluate(async ({ method, path, body, contentType, jsonType }) =>
        {
            // fetch's default credentials mode (same-origin) sends the console's own pts_session cookie.
            const init: RequestInit = { method }
            if (body !== undefined)
            {
                init.body = body
                init.headers = { [contentType]: jsonType }
            }
            const r = await fetch(path, init)
            return { status: r.status, text: await r.text() }
        }, { method, path, body, contentType: InHiveConsoleSmoke.ContentTypeHeader, jsonType: InHiveConsoleSmoke.JsonType })
    }

    /** One operator API call; Origin is never set (a non-browser client). */
    private async Api(method: string, path: string, body?: unknown): Promise<ApiAnswer>
    {
        const S = InHiveConsoleSmoke
        const headers: Record<string, string> = {}
        if (body !== undefined)
        {
            headers[S.ContentTypeHeader] = S.JsonType
        }
        if (this.sessionCookie !== undefined)
        {
            headers[S.CookieHeader] = this.sessionCookie
        }
        const response = await fetch(this.options.controlPlane + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
        const text = await response.text()
        return { status: response.status, body: InHiveConsoleSmoke.ParseJson(text), setCookie: response.headers.getSetCookie() }
    }

    private Detail(answer: ApiAnswer): string
    {
        const S = InHiveConsoleSmoke
        const error = answer.body?.[S.ErrorKey]
        return S.StatusWord + String(answer.status) + (typeof error === 'string' ? S.DetailSep + this.ScrubText(error) : '')
    }

    private async Kubectl(args: string[]): Promise<string>
    {
        const S = InHiveConsoleSmoke
        try
        {
            const { stdout } = await this.exec.Run(S.Kubectl, [S.ContextFlag, S.Context, ...args])
            return stdout
        }
        catch (e: unknown)
        {
            const err = e as { stderr?: unknown; message?: unknown }
            throw new KubectlError(typeof err.stderr === 'string' && err.stderr.length > 0 ? err.stderr : String(err.message ?? e))
        }
    }

    /** Runs an action; ok + its output, or not ok + the scrubbed error text. */
    private async Attempt(action: () => Promise<string>): Promise<{ ok: boolean; detail: string }>
    {
        try
        {
            return { ok: true, detail: await action() }
        }
        catch (err)
        {
            return { ok: false, detail: this.Scrub(err) }
        }
    }

    private HivePath(suffix: string): string
    {
        return InHiveConsoleSmoke.ApiPrefix + encodeURIComponent(this.options.hiveId) + suffix
    }

    private TenantPath(suffix: string): string
    {
        return InHiveConsoleSmoke.TenantsPrefix + encodeURIComponent(InHiveConsoleSmoke.TenantId) + suffix
    }

    /** The in-hive console origin the advert and discovery carry: https://console-<tenant>.<baseDomain>. */
    private ConsoleUrl(): string
    {
        return InHiveConsoleSmoke.HttpsScheme + this.ConsoleHost()
    }

    private ConsoleHost(): string
    {
        return K8sManifestBuilder.ConsoleHostOf(InHiveConsoleSmoke.TenantId, this.options.baseDomain)
    }

    /** Chromium maps the console and IdP hosts to the local ingress (the CA is not installed into the user's store). */
    private HostResolverRules(): string
    {
        const S = InHiveConsoleSmoke
        const hosts = [this.ConsoleHost(), K8sManifestBuilder.IdpBrowserHostOf(S.TenantId, this.options.baseDomain)]
        return S.HostResolverFlag + hosts.map(h => S.MapPrefix + h + S.MapSuffix).join(S.RuleSeparator)
    }

    /** Error text with kubectl redaction applied and every known secret value removed. */
    private Scrub(err: unknown): string
    {
        return this.ScrubText(KubectlError.Redact(err instanceof Error ? err.message : String(err)))
    }

    private ScrubText(text: string): string
    {
        let out = text
        for (const secret of this.secrets)
        {
            out = out.split(secret).join(InHiveConsoleSmoke.Redacted)
        }
        return out
    }

    private Expect(label: string, ok: boolean, detail: string = ''): void
    {
        const S = InHiveConsoleSmoke
        if (!ok)
        {
            this.failed = true
        }
        console.log((ok ? S.PassTag : S.FailTag) + label + (detail !== '' && !ok ? S.DetailSep + this.ScrubText(detail) : ''))
    }

    private static Sleep(ms: number): Promise<void>
    {
        return new Promise<void>(resolve => setTimeout(resolve, ms))
    }
}

if (InHiveConsoleSmoke.IsEntryPoint())
{
    await InHiveConsoleSmoke.Main()
}
