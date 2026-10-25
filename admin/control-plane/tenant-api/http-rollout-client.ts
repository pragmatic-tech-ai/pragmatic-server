import type { ManifestRecord } from '../manifest-record.js'
import type { HiveRolloutStatus } from '../platform-deployment-registry.js'
import { RolloutAdoptionRefusedError, RolloutUnavailableError, type IRolloutClient } from './rollout-client.js'

/**
 * The tenant-admin container's rollout seam over the hive-initiated agent channel: reads the adoptable versions and the
 * rollout status, and records an adoption (the hive's own agent then rolls locally). The channel scopes everything by the
 * hive in the path and the per-hive bearer, so the tenantId argument of ManifestsFor is implied by the hive and unused.
 * The bearer travels only in the Authorization header; no response body or token is ever echoed into an error.
 */
export class HttpRolloutClient implements IRolloutClient
{
    private static readonly AgentPrefix = '/agent/hives/'
    private static readonly AdoptableSegment = '/adoptable'
    private static readonly StatusSegment = '/status'
    private static readonly AdoptSegment = '/adopt'
    private static readonly AuthorizationHeader = 'Authorization'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly JsonType = 'application/json'
    private static readonly MethodGet = 'GET'
    private static readonly MethodPost = 'POST'
    private static readonly StatusForbidden = 403
    private static readonly UnreachableMessage = 'The platform agent channel is unreachable'
    private static readonly FailedMessagePrefix = 'The platform agent channel answered HTTP '
    private static readonly RefusedMessage = 'The platform refused to adopt this version'
    private static readonly MalformedMessage = 'The platform agent channel returned an unreadable response'

    public constructor(
        private readonly baseUrl: string,
        private readonly bearerToken: string,
        private readonly hiveId: string)
    {
    }

    public async ManifestsFor(_tenantId: string): Promise<readonly ManifestRecord[]>
    {
        const response = await this.Send(HttpRolloutClient.MethodGet, HttpRolloutClient.AdoptableSegment)
        return await this.ReadJson(response) as ManifestRecord[]
    }

    public async StatusFor(_hiveId: string): Promise<HiveRolloutStatus>
    {
        const response = await this.Send(HttpRolloutClient.MethodGet, HttpRolloutClient.StatusSegment)
        return await this.ReadJson(response) as HiveRolloutStatus
    }

    public async AdoptTarget(_hiveId: string, version: string): Promise<void>
    {
        await this.Send(HttpRolloutClient.MethodPost, HttpRolloutClient.AdoptSegment, JSON.stringify({ version }))
    }

    private async Send(method: string, segment: string, body?: string): Promise<Response>
    {
        const headers: Record<string, string> = { [HttpRolloutClient.AuthorizationHeader]: HttpRolloutClient.BearerPrefix + this.bearerToken }
        if (body !== undefined)
        {
            headers[HttpRolloutClient.ContentTypeHeader] = HttpRolloutClient.JsonType
        }
        let response: Response
        try
        {
            response = await fetch(this.baseUrl + HttpRolloutClient.AgentPrefix + encodeURIComponent(this.hiveId) + segment, { method, headers, body })
        }
        catch
        {
            throw new RolloutUnavailableError(HttpRolloutClient.UnreachableMessage)
        }
        if (!response.ok)
        {
            await response.arrayBuffer().catch(() => undefined)
            if (response.status === HttpRolloutClient.StatusForbidden)
            {
                throw new RolloutAdoptionRefusedError(HttpRolloutClient.RefusedMessage)
            }
            throw new RolloutUnavailableError(HttpRolloutClient.FailedMessagePrefix + response.status)
        }
        return response
    }

    private async ReadJson(response: Response): Promise<unknown>
    {
        try
        {
            return await response.json()
        }
        catch
        {
            throw new RolloutUnavailableError(HttpRolloutClient.MalformedMessage)
        }
    }
}
