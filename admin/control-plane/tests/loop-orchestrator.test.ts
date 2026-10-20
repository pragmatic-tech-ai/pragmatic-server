import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CreateAccountParams, GrantMutationDto, TokenIssuedDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { AdminConnectInfo } from '../admin-proxy.js'
import type { GraphDto, PromotionResultDto } from '../control-plane-host.js'
import { EnvStatus, EnvType, Template, type EnvironmentRecord } from '../environment-record.js'
import { LoopCommand, LoopOrchestrator, type ILoopEnvironments, type ILoopGraphs, type ILoopLogger, type ILoopLogin, type LoopDescriptor } from '../loop-orchestrator.js'

class Fixture
{
    public static readonly Root = 'C:/tmp/loop'
    public static readonly MakerToken = 'maker-token-SECRET-1'
    public static readonly DeployToken = 'deploy-token-SECRET-2'
    public static readonly AdminPw = 'admin-pw-SECRET-3'
    public static readonly Graph = 'g1'
}

class FakeEnvs implements ILoopEnvironments
{
    public readonly created: EnvironmentRecord[] = []
    public readonly deleted: string[] = []
    public readonly accounts: CreateAccountParams[] = []
    public readonly grants: GrantMutationDto[] = []

    public async Create(name: string, template: Template, type: EnvType): Promise<EnvironmentRecord>
    {
        const rec: EnvironmentRecord = {
            name,
            type,
            template,
            tenantId: type === EnvType.Runtime ? 'contoso' : name,
            hostPort: type === EnvType.Runtime ? 8102 : 8101,
            containerName: name,
            volumeName: name,
            bundleDir: name,
            createdAt: '',
            status: EnvStatus.Running
        }
        this.created.push(rec)
        return rec
    }

    public async Delete(name: string): Promise<void>
    {
        this.deleted.push(name)
    }

    public List(): readonly EnvironmentRecord[]
    {
        return this.created
    }

    public async AdminInfoFor(_name: string): Promise<AdminConnectInfo>
    {
        return { httpUrl: 'http://localhost:8102', wsUrl: 'ws://localhost:8102', tenant: 'contoso', email: 'admin@contoso.test', password: Fixture.AdminPw }
    }

    public async AdminIssueMakerToken(_name: string): Promise<TokenIssuedDto>
    {
        return { token: Fixture.MakerToken } as TokenIssuedDto
    }

    public async AdminCreateAccount(_name: string, params: CreateAccountParams): Promise<void>
    {
        this.accounts.push(params)
    }

    public async AdminGrantRole(_name: string, mutation: GrantMutationDto): Promise<void>
    {
        this.grants.push(mutation)
    }
}

class FakeGraphs implements ILoopGraphs
{
    public promoted: string[] = []

    public async Create(_env: string, name: string): Promise<GraphDto>
    {
        return { name, description: '', packageCount: 0, createdAt: '' }
    }

    public async Promote(source: string, graphName: string, target: string): Promise<PromotionResultDto>
    {
        this.promoted.push(source + '>' + target)
        return { graphName, packageCount: 1, targetEnv: target }
    }
}

class FakeLogin implements ILoopLogin
{
    public async Login(): Promise<string>
    {
        return Fixture.DeployToken
    }
}

class RecordingLogger implements ILoopLogger
{
    public readonly lines: string[] = []

    public Log(message: string): void
    {
        this.lines.push(message)
    }
}

class Harness
{
    public readonly envs = new FakeEnvs()
    public readonly graphs = new FakeGraphs()
    public readonly logger = new RecordingLogger()
    public readonly orchestrator = new LoopOrchestrator(this.envs, this.graphs, new FakeLogin(), this.logger, Fixture.Root)
}

test('ParseCommand maps create-dev with data-root', () =>
{
    const parsed = LoopOrchestrator.ParseCommand(['create-dev', '--data-root', Fixture.Root])
    assert.deepEqual(parsed, { command: LoopCommand.CreateDev, dataRoot: Fixture.Root })
})

test('ParseCommand maps promote-and-provision with graph and rejects bad input', () =>
{
    const parsed = LoopOrchestrator.ParseCommand(['promote-and-provision', '--data-root', Fixture.Root, '--graph', Fixture.Graph])
    assert.deepEqual(parsed, { command: LoopCommand.PromoteAndProvision, dataRoot: Fixture.Root, graph: Fixture.Graph })
    assert.equal(LoopOrchestrator.ParseCommand(['teardown', '--data-root', Fixture.Root]).command, LoopCommand.Teardown)
    assert.throws(() => LoopOrchestrator.ParseCommand(['bogus', '--data-root', Fixture.Root]))
    assert.throws(() => LoopOrchestrator.ParseCommand(['create-dev']))
    assert.throws(() => LoopOrchestrator.ParseCommand(['create-dev', '--data-root']))
})

test('CreateDev descriptor carries devWsUrl/graphName/makerToken keys', async () =>
{
    const h = new Harness()
    const d = await h.orchestrator.CreateDev(Fixture.Graph)
    const round = JSON.parse(JSON.stringify(d)) as LoopDescriptor
    assert.deepEqual(Object.keys(round).sort(), ['dataRoot', 'devEnv', 'devWsUrl', 'graphName', 'makerToken'])
    assert.equal(round.devWsUrl, 'ws://localhost:8101/?tenant=loop-dev')
    assert.equal(round.graphName, Fixture.Graph)
    assert.equal(round.makerToken, Fixture.MakerToken)
    assert.equal(h.envs.created[0].template, Template.DevBlank)
})

test('PromoteAndProvision descriptor has the exact contract keys and grants only the reader', async () =>
{
    const h = new Harness()
    const d = await h.orchestrator.PromoteAndProvision(Fixture.Graph)
    const round = JSON.parse(JSON.stringify(d)) as LoopDescriptor
    assert.deepEqual(Object.keys(round).sort(), ['appOriginBase', 'deployToken', 'reader', 'runtimeEnv', 'runtimeHostPort', 'runtimeWsUrl', 'tenant', 'ungranted'])
    assert.equal(round.appOriginBase, 'http://localhost:8102')
    assert.equal(round.runtimeWsUrl, 'ws://localhost:8102/?tenant=contoso')
    assert.equal(round.deployToken, Fixture.DeployToken)
    assert.deepEqual(Object.keys(round.reader ?? {}).sort(), ['email', 'password'])
    assert.equal(h.envs.accounts.length, 2)
    assert.equal(h.envs.grants.length, 1)
    assert.equal(h.envs.grants[0].subject, 'loop-reader')
    assert.deepEqual(h.graphs.promoted, ['loop-dev>loop-rt'])
    assert.notEqual(round.reader?.password, round.ungranted?.password)
})

test('Teardown deletes created envs and reports ok', async () =>
{
    const h = new Harness()
    await h.orchestrator.CreateDev()
    await h.orchestrator.PromoteAndProvision()
    const d = await h.orchestrator.Teardown()
    assert.deepEqual(d, { ok: true })
    assert.deepEqual(h.envs.deleted, ['loop-dev', 'loop-rt'])
})

test('tokens are never written to the injected logger', async () =>
{
    const h = new Harness()
    const dev = await h.orchestrator.CreateDev()
    const rt = await h.orchestrator.PromoteAndProvision()
    await h.orchestrator.Teardown()
    const secrets = [Fixture.MakerToken, Fixture.DeployToken, Fixture.AdminPw, rt.reader?.password ?? '', rt.ungranted?.password ?? '']
    assert.ok(h.logger.lines.length > 0)
    for (const line of h.logger.lines)
    {
        for (const secret of secrets)
        {
            assert.ok(secret !== '' && !line.includes(secret))
        }
    }
    assert.equal(dev.makerToken, Fixture.MakerToken)
})
