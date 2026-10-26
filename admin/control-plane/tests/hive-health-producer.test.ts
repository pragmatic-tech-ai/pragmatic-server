import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { HiveHealthProducer, type IEnvironmentHealthSource } from '../hive-health-producer.js'
import type { EnvironmentPlacement } from '../environment-placement.js'
import type { HiveOrchestratorFactory } from '../hive-orchestrator-factory.js'
import type { IHiveOrchestrator, WorkloadHealth } from '../hive-orchestrator.js'
import type { EnvironmentRecord } from '../environment-record.js'
import type { EnvironmentWorkload } from '../environment-workload.js'
import type { HiveRecord } from '../platform-records.js'

class ProducerFixture
{
    public static readonly HiveId = 'h1'
    public static readonly Secret = 'SECRET-TOKEN-xyz'
    public static readonly BadEnv = 'bad'
    public static readonly GoodEnv = 'good'

    public static Hive(): HiveRecord
    {
        return { id: ProducerFixture.HiveId } as unknown as HiveRecord
    }

    public static Source(): IEnvironmentHealthSource
    {
        const envs = [
            { name: ProducerFixture.BadEnv, hiveId: ProducerFixture.HiveId },
            { name: ProducerFixture.GoodEnv, hiveId: ProducerFixture.HiveId }
        ] as unknown as EnvironmentRecord[]
        return { List: () => envs }
    }

    public static Placement(): EnvironmentPlacement
    {
        return { WorkloadFor: (e: EnvironmentRecord) => ({ environmentName: e.name }) } as unknown as EnvironmentPlacement
    }

    public static Factory(resolve: () => IHiveOrchestrator): HiveOrchestratorFactory
    {
        return { For: () => resolve() } as unknown as HiveOrchestratorFactory
    }

    public static Orchestrator(): IHiveOrchestrator
    {
        return {
            Health: async (w: EnvironmentWorkload): Promise<WorkloadHealth> =>
            {
                if (w.environmentName === ProducerFixture.BadEnv)
                {
                    throw new Error(ProducerFixture.Secret)
                }
                return { ready: true, runningImage: 'img:1', detail: 'ok' }
            }
        } as unknown as IHiveOrchestrator
    }
}

describe('HiveHealthProducer', () =>
{
    it('omits an env whose probe throws and returns the rest without leaking the error', async () =>
    {
        const producer = new HiveHealthProducer(
            ProducerFixture.Source(),
            ProducerFixture.Factory(() => ProducerFixture.Orchestrator()),
            ProducerFixture.Placement())
        const dtos = await producer.Produce(ProducerFixture.Hive())
        assert.deepEqual(dtos, [{ environmentName: ProducerFixture.GoodEnv, ready: true, runningImage: 'img:1', detail: 'ok' }])
        assert.ok(!JSON.stringify(dtos).includes(ProducerFixture.Secret))
    })

    it('still rejects when the orchestrator cannot be resolved', async () =>
    {
        const producer = new HiveHealthProducer(
            ProducerFixture.Source(),
            ProducerFixture.Factory(() =>
            {
                throw new Error('no orchestrator')
            }),
            ProducerFixture.Placement())
        await assert.rejects(() => producer.Produce(ProducerFixture.Hive()), /no orchestrator/)
    })
})
