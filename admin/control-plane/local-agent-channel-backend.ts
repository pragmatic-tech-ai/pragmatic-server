import type { PlatformDeploymentRegistry } from './platform-deployment-registry.js'
import { ConsoleAdvertReceiver, ConsoleNotEnabledError, InvalidConsoleAdvertError } from './console-advert-receiver.js'
import { AdoptionLedgerDtoMapper } from './tenant-api/rollout-client.js'
import { DomainNotClaimedError, DomainVerificationUnavailableError, DomainVerifyThrottledError } from './tenant-api/tenant-email-domains.js'
import { InvalidEmailDomainError } from './email-domain-policy.js'
import type { DomainVerificationAnswer } from './domain-verification-record.js'
import type { HiveHealthDto } from './hive-health-producer.js'
import { AgentChannelOperation, type AgentChannelReply, type AgentChannelRequest, type IAgentChannelBackend } from './agent-channel-backend.js'
import { PlaneHttp } from './plane-http.js'
import { AgentUnauthorizedError, ChannelNotSubscribedError, HiveNotRegisteredError, ManifestNotGatedError, ManifestWithdrawnError, ReleaseNotRunnableYetError, TenantOnHoldError, UnknownHiveError, UnknownManifestError, VersionBelowFloorError } from './rollout-errors.js'

/** The agent channel answered in-process over the platform registries: verifies the hive's bearer, runs the operation
 *  and maps every failure to its fixed-text reply (an unregistered hive is indistinguishable from a wrong token, and
 *  no inner-error text reaches the reply or the log). */
export class LocalAgentChannelBackend implements IAgentChannelBackend
{
    public static readonly UnauthorizedReply: AgentChannelReply = { Status: 401, Body: { error: 'Unauthorized' } }
    private static readonly LimitParam = 'limit'
    private static readonly DefaultLedgerLimit = 200
    private static readonly StatusNoContent = 204
    private static readonly StatusBadRequest = 400
    private static readonly StatusConflict = 409
    private static readonly StatusForbidden = 403
    private static readonly StatusTooManyRequests = 429
    private static readonly StatusUnavailable = 503
    private static readonly StatusInternal = 500
    private static readonly InvalidDomainMessage = 'Invalid email domain'
    private static readonly DomainNotClaimedMessage = 'Domain is not among the reported email domains'
    private static readonly ThrottledMessage = 'Too many verification attempts'
    private static readonly UnavailableMessage = 'Domain verification unavailable'
    private static readonly BadRequestMessage = 'Request body must be { environments: HiveHealth[] }'
    private static readonly VersionKey = 'version'
    private static readonly AdoptBadRequestMessage = 'Request body must be { version: string }'
    private static readonly AdoptRefusedMessage = 'Version is not adoptable for this hive'
    private static readonly InternalMessage = 'Internal error'
    private static readonly FallbackErrorName = 'Error'
    private static readonly LogPrefix = '[agent-channel]'
    private static readonly EmptyBody = ''

    public constructor(private readonly deployments: PlatformDeploymentRegistry, private readonly adverts?: ConsoleAdvertReceiver)
    {
    }

    public ServesConsole(): boolean
    {
        return this.adverts !== undefined
    }

    public async Handle(request: AgentChannelRequest): Promise<AgentChannelReply>
    {
        try
        {
            await this.deployments.VerifyAgentToken(request.HiveId, request.Token)
            return await this.Run(request)
        }
        catch (err)
        {
            return LocalAgentChannelBackend.ErrorReply(err)
        }
    }

    private async Run(request: AgentChannelRequest): Promise<AgentChannelReply>
    {
        const L = LocalAgentChannelBackend
        const id = request.HiveId
        const body = request.Body ?? L.EmptyBody
        switch (request.Operation)
        {
            case AgentChannelOperation.Target:
            {
                const target = this.deployments.TargetFor(id)
                return target === undefined
                    ? { Status: PlaneHttp.StatusNotFound, Body: { error: PlaneHttp.NotFoundMessage } }
                    : { Status: PlaneHttp.StatusOk, Body: { version: target.version, image: target.image } }
            }
            case AgentChannelOperation.Adoptable:
                return { Status: PlaneHttp.StatusOk, Body: this.deployments.AdoptableFor(id) }
            case AgentChannelOperation.Status:
                return { Status: PlaneHttp.StatusOk, Body: this.deployments.StatusFor(id) }
            case AgentChannelOperation.Ledger:
                return { Status: PlaneHttp.StatusOk, Body: AdoptionLedgerDtoMapper.ToDtos(this.deployments.LedgerForHive(id, L.LedgerLimit(request.Query))) }
            case AgentChannelOperation.Adopt:
            {
                const version = L.ParseAdoption(body)
                if (version === undefined)
                {
                    return { Status: L.StatusBadRequest, Body: { error: L.AdoptBadRequestMessage } }
                }
                await this.deployments.RecordAdoption(id, version)
                return { Status: L.StatusNoContent }
            }
            case AgentChannelOperation.Console:
                return this.ReceiveConsoleAdvert(id, body)
            case AgentChannelOperation.ConsoleVerifyDomain:
                return this.ReceiveVerifyDomain(id, body)
            case AgentChannelOperation.Snapshot:
            {
                const environments = L.ParseSnapshot(body)
                if (environments === undefined)
                {
                    return { Status: L.StatusBadRequest, Body: { error: L.BadRequestMessage } }
                }
                await this.deployments.ReportSnapshot(id, environments)
                return { Status: L.StatusNoContent }
            }
        }
    }

    /** Stores the advert the hive's console reports and answers the email domains the control plane refused, plus the
     *  tenant's last operator Owner reset and the domain verifications when there are any. */
    private async ReceiveConsoleAdvert(id: string, raw: string): Promise<AgentChannelReply>
    {
        const outcome = await (this.adverts as ConsoleAdvertReceiver).Receive(id, LocalAgentChannelBackend.ParseConsoleJson(raw, ConsoleAdvertReceiver.BadShape))
        const answer: { refusedEmailDomains: string[]; ownerResetAt?: string; domainVerifications?: DomainVerificationAnswer[] } = { refusedEmailDomains: outcome.refusedEmailDomains }
        if (outcome.ownerResetAt !== undefined)
        {
            answer.ownerResetAt = outcome.ownerResetAt
        }
        if (outcome.domainVerifications !== undefined)
        {
            answer.domainVerifications = outcome.domainVerifications
        }
        return { Status: PlaneHttp.StatusOk, Body: answer }
    }

    private async ReceiveVerifyDomain(id: string, raw: string): Promise<AgentChannelReply>
    {
        const verification = await (this.adverts as ConsoleAdvertReceiver).VerifyDomain(id, LocalAgentChannelBackend.ParseConsoleJson(raw, ConsoleAdvertReceiver.BadVerifyShape))
        return { Status: PlaneHttp.StatusOk, Body: { verification } }
    }

    /** The ?limit= of a ledger request, clamped to [0, DefaultLedgerLimit]; the default when absent or not a number. */
    private static LedgerLimit(query: Record<string, string> | undefined): number
    {
        const raw = query?.[LocalAgentChannelBackend.LimitParam]
        const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10)
        return Number.isFinite(n) ? Math.min(Math.max(n, 0), LocalAgentChannelBackend.DefaultLedgerLimit) : LocalAgentChannelBackend.DefaultLedgerLimit
    }

    /** The parsed JSON of a console-route body; a body that is not JSON raises the given fixed sentence as a 400. */
    private static ParseConsoleJson(raw: string, badShape: string): unknown
    {
        try
        {
            return JSON.parse(raw)
        }
        catch
        {
            throw new InvalidConsoleAdvertError(badShape)
        }
    }

    /** The version of a { version: non-empty string } body, or undefined when it is anything else. */
    private static ParseAdoption(raw: string): string | undefined
    {
        const body = LocalAgentChannelBackend.ParseObject(raw)
        if (body === undefined)
        {
            return undefined
        }
        const version = body[LocalAgentChannelBackend.VersionKey]
        return typeof version === 'string' && version.length > 0 ? version : undefined
    }

    /** The validated environments of a { environments: HiveHealthDto[] } body, or undefined when it is anything else. */
    private static ParseSnapshot(raw: string): HiveHealthDto[] | undefined
    {
        const body = LocalAgentChannelBackend.ParseObject(raw)
        const environments = body?.environments
        if (!Array.isArray(environments) || !environments.every(e => LocalAgentChannelBackend.IsHiveHealth(e)))
        {
            return undefined
        }
        return (environments as HiveHealthDto[]).map(h => ({ environmentName: h.environmentName, ready: h.ready, runningImage: h.runningImage, detail: h.detail }))
    }

    /** A JSON object body, or undefined for malformed JSON, null, arrays and scalars. */
    private static ParseObject(raw: string): Record<string, unknown> | undefined
    {
        let body: unknown
        try
        {
            body = JSON.parse(raw)
        }
        catch
        {
            return undefined
        }
        return body === null || typeof body !== 'object' || Array.isArray(body) ? undefined : body as Record<string, unknown>
    }

    private static IsHiveHealth(e: unknown): e is HiveHealthDto
    {
        if (e === null || typeof e !== 'object' || Array.isArray(e))
        {
            return false
        }
        const h = e as Record<string, unknown>
        return typeof h.environmentName === 'string' && h.environmentName.length > 0
            && typeof h.ready === 'boolean'
            && (h.runningImage === undefined || typeof h.runningImage === 'string')
            && typeof h.detail === 'string'
    }

    /** Maps a failure to its fixed-text reply. */
    private static ErrorReply(err: unknown): AgentChannelReply
    {
        const L = LocalAgentChannelBackend
        if (err instanceof AgentUnauthorizedError || err instanceof HiveNotRegisteredError || err instanceof UnknownHiveError)
        {
            return L.UnauthorizedReply
        }
        if (err instanceof InvalidConsoleAdvertError)
        {
            return { Status: L.StatusBadRequest, Body: { error: err.message } }
        }
        if (err instanceof ConsoleNotEnabledError)
        {
            return { Status: L.StatusConflict, Body: { error: err.message } }
        }
        // Verification refusals carry fixed text, never the inner message. UnknownTenantError is deliberately unmapped (a logged 500).
        if (err instanceof InvalidEmailDomainError)
        {
            return { Status: L.StatusBadRequest, Body: { error: L.InvalidDomainMessage } }
        }
        if (err instanceof DomainNotClaimedError)
        {
            return { Status: L.StatusConflict, Body: { error: L.DomainNotClaimedMessage } }
        }
        if (err instanceof DomainVerifyThrottledError)
        {
            return { Status: L.StatusTooManyRequests, Body: { error: L.ThrottledMessage } }
        }
        if (err instanceof DomainVerificationUnavailableError)
        {
            return { Status: L.StatusUnavailable, Body: { error: L.UnavailableMessage } }
        }
        // Route-agnostic: only adopt raises these; the agent never learns which rule failed.
        if (err instanceof ManifestNotGatedError || err instanceof UnknownManifestError || err instanceof ManifestWithdrawnError ||
            err instanceof TenantOnHoldError || err instanceof ChannelNotSubscribedError || err instanceof VersionBelowFloorError ||
            err instanceof ReleaseNotRunnableYetError)
        {
            return { Status: L.StatusForbidden, Body: { error: L.AdoptRefusedMessage } }
        }
        console.error(L.LogPrefix, err instanceof Error ? err.name : L.FallbackErrorName)
        return { Status: L.StatusInternal, Body: { error: L.InternalMessage } }
    }
}
