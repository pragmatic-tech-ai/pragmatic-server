import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AccessScope, GraphEngine, GraphReader, GraphTransaction, IBeginOptions } from '@pragmatic-tech-ai/graph'
import { AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'
import { Principal, PrincipalKind } from '@pragmatic-tech-ai/todl-identity'
import { EnvironmentFixture } from '../../environment/tests/environment-fixture.js'
import { Tier1Fx } from '../../environment/tests/tier1-fixture.js'

/** Records the connector context key of every reader and transaction the engine opens. */
class RecordingEngine
{
    public readonly Reads: (string | undefined)[] = []
    public readonly Begins: (string | undefined)[] = []

    public constructor(engine: GraphEngine)
    {
        const read = engine.BeginRead.bind(engine)
        const begin = engine.Begin.bind(engine)
        engine.BeginRead = (scope: AccessScope, options?: IBeginOptions): Promise<GraphReader> =>
        {
            this.Reads.push(options?.Connector?.Key)
            return read(scope, options)
        }
        engine.Begin = (scope: AccessScope, options?: IBeginOptions): Promise<GraphTransaction> =>
        {
            this.Begins.push(options?.Connector?.Key)
            return begin(scope, options)
        }
    }
}

class ContextFx
{
    public static readonly Query = 'MATCH (e:`hr.Employee`) RETURN e.name AS name'
    public static readonly Create = 'CREATE (e:`hr.Employee`) SET e.name = $name RETURN e'
    public static readonly NameParameter = 'name'
    public static readonly Created = 'created'
}

describe('caller connector context', () =>
{
    test('every engine call carries the caller context', async () =>
    {
        await Tier1Fx.Run({ Identity: true, SecurityModel: Tier1Fx.Setting() }, async (fx, server) =>
        {
            const recording = new RecordingEngine(await Tier1Fx.Engine(server))
            const client = await fx.Connect(new Principal(Tier1Fx.Alice, EnvironmentFixture.TenantId, PrincipalKind.User, new Map(), []))
            await client.CypherQuery(ContextFx.Query)
            const executed = await client.CypherExecute(ContextFx.Create, { [ContextFx.NameParameter]: ContextFx.Created })
            assert.equal(executed.status, AppWriteStatus.Applied, JSON.stringify(executed))
            assert.ok(recording.Reads.length > 0 && recording.Begins.length > 0, 'the query read and the execute wrote')
            assert.deepEqual([...new Set([...recording.Reads, ...recording.Begins])], [Tier1Fx.Alice], 'every reader, transaction and Cypher run is alice\'s')
        })
    })
})
