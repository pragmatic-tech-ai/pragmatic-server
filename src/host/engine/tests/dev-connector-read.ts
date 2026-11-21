import { AccessContext, Grant, Principal, PrincipalKind, ResourceAuthorizationPolicy, ResourceKind, ResourceRef, Role, Realm, RealmKind } from '@pragmatic-tech-ai/pragmatic-identity'
import type { EntityDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { PagingLimits } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import type { PragmaticServer } from '../../../pragmatic-server.js'

/**
 * Test-only: reads one concept of the first connector model of a dev server's open solution through
 * `PragmaticServer.DevConnectors()` (the engine path of ruling S14), as an owner of `environmentId`. A read that fails
 * rejects with an Error whose message joins the messages of the whole cause chain (the engine wraps a connector's open
 * failure), so a test can match the root cause's text.
 */
export class DevConnectorRead
{
    private static readonly DefaultEnvironment = 't1'
    private static readonly PrincipalId = 'p1'
    private static readonly Separator = ' <- '
    private static readonly NoModelsMessage = 'the open solution has no connector model'

    private constructor()
    {
    }

    public static async Rows(server: PragmaticServer, concept: string, environmentId: string = DevConnectorRead.DefaultEnvironment): Promise<EntityDto[]>
    {
        const service = server.DevConnectors()
        const models = await service.List()
        if (models.length === 0) throw new Error(DevConnectorRead.NoModelsMessage)
        try
        {
            return (await service.Read(DevConnectorRead.Context(environmentId), { modelId: models[0]!.modelId, concept }, new PagingLimits())).items
        }
        catch (error)
        {
            throw new Error(DevConnectorRead.Chain(error), { cause: error })
        }
    }

    public static Context(environmentId: string): AccessContext
    {
        const realm = new Realm(environmentId, RealmKind.SelfHosted, environmentId)
        const principal = new Principal(DevConnectorRead.PrincipalId, environmentId, PrincipalKind.User, new Map(), [])
        const grants = [new Grant(DevConnectorRead.PrincipalId, Role.Owner, new ResourceRef(ResourceKind.Realm, environmentId, []))]
        return new AccessContext(principal, realm, grants, new ResourceAuthorizationPolicy())
    }

    private static Chain(error: unknown): string
    {
        const messages: string[] = []
        for (let current: unknown = error; current !== undefined && current !== null; current = current instanceof Error ? current.cause : undefined)
        {
            messages.push(current instanceof Error ? current.message : String(current))
            if (!(current instanceof Error)) break
        }
        return messages.join(DevConnectorRead.Separator)
    }
}
