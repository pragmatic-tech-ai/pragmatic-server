import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CreateAccountParams, GrantMutationDto, SecurityCatalogDto, SecurityModelDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { BaseRole } from '@pragmatic-tech-ai/todl-identity'
import type { PromotionResultDto } from '../../control-plane-host.js'
import { EnvStatus, EnvType, Template } from '../../environment-record.js'
import { LoopCommand, LoopOrchestrator, type ILoopDatabase, type ILoopEnvironments, type ILoopGraphs, type ILoopLogger, type ILoopReach, type LoopEnvironment, type DevDescriptor, type RuntimeDescriptor, type PromoteDescriptor } from '../loop-orchestrator.js'

class Fixture
{
    public static readonly Stack = 'C:/stack/stack.json'
    public static readonly Graph = 'g1'
    public static readonly Origin = 'http://localhost:18100'
    public static readonly StackPassword = 'stack-pw-SECRET-1'
}

class FakeEnvs implements ILoopEnvironments
{
    public readonly created: { name: string; template: Template; type: EnvType }[] = []
    public status: string = EnvStatus.Running
    public readonly deleted: string[] = []
    public readonly accounts: CreateAccountParams[] = []
    public readonly grants: GrantMutationDto[] = []
    public securityModel: SecurityModelDto | undefined
    public readonly securitySets: SecurityModelDto[] = []
    public catalogConcepts: string[] = ['contoso.Customer', 'northwind.Order']

    public async Create(name: string, template: Template, type: EnvType): Promise<LoopEnvironment>
    {
        this.created.push({ name, template, type })
        return { name, environmentId: name, status: this.status }
    }

    public async Delete(name: string): Promise<boolean>
    {
        if (!this.created.some(e => e.name === name))
        {
            return false
        }
        this.deleted.push(name)
        return true
    }

    public async AdminCreateAccount(_name: string, params: CreateAccountParams): Promise<void>
    {
        this.accounts.push(params)
    }

    public async AdminGrantRole(_name: string, mutation: GrantMutationDto): Promise<void>
    {
        this.grants.push(mutation)
    }

    public async AdminGetSecurityModel(_name: string): Promise<SecurityModelDto | undefined>
    {
        return this.securityModel
    }

    public async AdminSetSecurityModel(_name: string, securityModel: SecurityModelDto): Promise<void>
    {
        this.securityModel = securityModel
        this.securitySets.push(securityModel)
    }

    public async AdminGetSecurityCatalog(_name: string): Promise<SecurityCatalogDto>
    {
        return { roles: [], concepts: this.catalogConcepts.map(name => ({ name, package: 'p', owned: false })), securedFields: [], profiles: [] }
    }
}

class FakeGraphs implements ILoopGraphs
{
    public readonly createdGraphs: string[] = []
    public readonly promoted: string[] = []

    public async Create(env: string, name: string): Promise<void>
    {
        this.createdGraphs.push(env + '/' + name)
    }

    public async Promote(source: string, graphName: string, target: string): Promise<PromotionResultDto>
    {
        this.promoted.push(source + '>' + target)
        return { graphName, packageCount: 1, targetEnv: target }
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

class FakeDatabase implements ILoopDatabase
{
    public readonly executed: string[] = []

    public async Exec(_env: string, sql: string): Promise<number>
    {
        this.executed.push(sql)
        return 1
    }
}

class FakeReach implements ILoopReach
{
    public readonly opened: string[] = []
    public readonly closed: string[] = []

    public async Open(envName: string): Promise<string>
    {
        this.opened.push(envName)
        return Fixture.Origin
    }

    public async Close(envName: string): Promise<void>
    {
        this.closed.push(envName)
    }
}

class Harness
{
    public readonly envs = new FakeEnvs()
    public readonly graphs = new FakeGraphs()
    public readonly logger = new RecordingLogger()
    public readonly database = new FakeDatabase()
    public readonly reach = new FakeReach()
    public readonly orchestrator = new LoopOrchestrator(this.envs, this.graphs, this.logger, this.database, this.reach)
}

test('ParseCommand defaults --stack, honours an explicit one, requires --graph for promote and --sql for db-exec, and rejects bad input', () =>
{
    assert.deepEqual(LoopOrchestrator.ParseCommand(['create-dev'], Fixture.Stack), { command: LoopCommand.CreateDev, stack: Fixture.Stack })
    assert.deepEqual(LoopOrchestrator.ParseCommand(['promote', '--stack', 'other.json', '--graph', Fixture.Graph], Fixture.Stack), { command: LoopCommand.Promote, stack: 'other.json', graph: Fixture.Graph })
    assert.equal(LoopOrchestrator.ParseCommand(['teardown'], Fixture.Stack).command, LoopCommand.Teardown)
    assert.throws(() => LoopOrchestrator.ParseCommand(['promote'], Fixture.Stack))
    assert.throws(() => LoopOrchestrator.ParseCommand(['db-exec'], Fixture.Stack))
    assert.throws(() => LoopOrchestrator.ParseCommand(['promote-and-provision'], Fixture.Stack))
    assert.throws(() => LoopOrchestrator.ParseCommand(['create-dev', '--stack'], Fixture.Stack))
})

test('CreateDev creates the dev environment and its graph and answers the fixed keys', async () =>
{
    const h = new Harness()
    const d = await h.orchestrator.CreateDev(Fixture.Graph)
    assert.deepEqual(JSON.parse(JSON.stringify(d)) as DevDescriptor, { devEnv: 'loop-dev', graphName: Fixture.Graph })
    assert.deepEqual(h.envs.created, [{ name: 'loop-dev', template: Template.DevBlank, type: EnvType.Development }])
    assert.deepEqual(h.graphs.createdGraphs, ['loop-dev/' + Fixture.Graph])
})

test('CreateRuntime answers the fixed keys over the opened reach, grants only the reader, and does not promote', async () =>
{
    const h = new Harness()
    const d = await h.orchestrator.CreateRuntime()
    const round = JSON.parse(JSON.stringify(d)) as RuntimeDescriptor
    assert.deepEqual(Object.keys(round).sort(), ['appOriginBase', 'reader', 'runtimeEnv', 'runtimeWsUrl', 'tenant', 'ungranted'])
    assert.equal(round.appOriginBase, Fixture.Origin)
    assert.equal(round.runtimeWsUrl, 'ws://localhost:18100/?environment=loop-rt')
    assert.equal(round.tenant, 'loop-rt')
    assert.deepEqual(h.envs.created[0], { name: 'loop-rt', template: Template.RuntimePostgres, type: EnvType.Runtime })
    assert.deepEqual(h.reach.opened, ['loop-rt'])
    assert.deepEqual(h.envs.accounts.map(a => a.email), ['r@t.io', 'u@t.io'])
    assert.equal(h.envs.grants.length, 1)
    assert.equal(h.envs.grants[0]!.subject, 'loop-reader')
    assert.deepEqual(h.graphs.promoted, [])
    assert.notEqual(round.reader.password, round.ungranted.password)
})

test('WsUrlOf maps http to ws and https to wss on the same host', () =>
{
    assert.equal(LoopOrchestrator.WsUrlOf('http://localhost:18100', 'loop-rt'), 'ws://localhost:18100/?environment=loop-rt')
    assert.equal(LoopOrchestrator.WsUrlOf('https://rt.example.test', 'loop-rt'), 'wss://rt.example.test/?environment=loop-rt')
})

// The runtime env's security setting must leave the admin as System Administrator and the reader (never the ungranted user)
// as a Reader of every promoted concept after each promote.
test('Promote secures the runtime: admin is System Administrator, the reader reads every catalog concept, the ungranted user gets nothing', async () =>
{
    const h = new Harness()
    await h.orchestrator.CreateRuntime()
    await h.orchestrator.Promote(Fixture.Graph)
    const model = h.envs.securityModel
    assert.ok(model !== undefined)
    assert.deepEqual(model.roleAssignments.find(a => a.role === BaseRole.SystemAdministrator)?.principalIds, ['admin'])
    assert.deepEqual(model.roleAssignments.find(a => a.role === BaseRole.Reader)?.principalIds, ['loop-reader'])
    assert.deepEqual(model.roleOverrides.map(o => o.concept), h.envs.catalogConcepts)
    assert.ok(!model.users.some(u => u.principalId === 'loop-ungranted'))
})

test('a re-promote re-secures the runtime over the concepts the catalog now holds', async () =>
{
    const h = new Harness()
    await h.orchestrator.CreateRuntime()
    await h.orchestrator.Promote(Fixture.Graph)
    h.envs.catalogConcepts = [...h.envs.catalogConcepts, 'contoso.Product']
    await h.orchestrator.Promote(Fixture.Graph)
    assert.equal(h.envs.securitySets.length, 2)
    assert.deepEqual(h.envs.securityModel?.roleOverrides.map(o => o.concept), ['contoso.Customer', 'northwind.Order', 'contoso.Product'])
})

test('Promote returns the exact keys, targets the existing runtime env, creates nothing, and is re-runnable', async () =>
{
    const h = new Harness()
    await h.orchestrator.CreateDev()
    await h.orchestrator.CreateRuntime()
    const createdBefore = h.envs.created.length
    const first = await h.orchestrator.Promote(Fixture.Graph)
    const second = await h.orchestrator.Promote(Fixture.Graph) as PromoteDescriptor
    assert.deepEqual(Object.keys(second).sort(), ['graphName', 'packageCount', 'targetEnv'])
    assert.deepEqual(second, first)
    assert.equal(second.targetEnv, 'loop-rt')
    assert.equal(h.envs.created.length, createdBefore)
    assert.deepEqual(h.graphs.promoted, ['loop-dev>loop-rt', 'loop-dev>loop-rt'])
})

test('DbExec runs the SQL against the runtime env and never logs it', async () =>
{
    const h = new Harness()
    const sql = 'INSERT INTO t VALUES (1)'
    assert.deepEqual(await h.orchestrator.DbExec(sql), { ok: true, rowCount: 1 })
    assert.deepEqual(h.database.executed, [sql])
    assert.ok(!h.logger.lines.some(l => l.includes(sql)))
})

test('Teardown closes the reach and deletes the created envs; it is idempotent', async () =>
{
    const h = new Harness()
    assert.deepEqual(await h.orchestrator.Teardown(), { ok: true })
    await h.orchestrator.CreateDev()
    await h.orchestrator.CreateRuntime()
    assert.deepEqual(await h.orchestrator.Teardown(), { ok: true })
    assert.deepEqual(h.envs.deleted, ['loop-dev', 'loop-rt'])
    assert.deepEqual(h.reach.closed, ['loop-rt', 'loop-rt'])
    assert.ok(h.logger.lines.some(l => l.includes('loop-dev (absent)')))
})

test('generated and held passwords are never logged; ReportFailure redacts them but keeps the class and message', async () =>
{
    const h = new Harness()
    h.orchestrator.HoldSecret(Fixture.StackPassword)
    const rt = await h.orchestrator.CreateRuntime()
    await h.orchestrator.Teardown()
    for (const line of h.logger.lines)
    {
        assert.ok(!line.includes(rt.reader.password) && !line.includes(rt.ungranted.password) && !line.includes(Fixture.StackPassword))
    }
    h.logger.lines.length = 0
    h.orchestrator.ReportFailure(new RangeError('login failed for ' + Fixture.StackPassword + ' pw ' + rt.reader.password))
    const out = h.logger.lines.join(' | ')
    assert.ok(out.includes('***') && out.includes('RangeError') && out.includes('login failed for'))
    assert.ok(!out.includes(Fixture.StackPassword) && !out.includes(rt.reader.password))
})

test('CreateDev refuses an environment that is not running', async () =>
{
    const h = new Harness()
    h.envs.status = EnvStatus.Failed
    await assert.rejects(() => h.orchestrator.CreateDev())
})

test('Run dispatches create-dev honouring --graph, and promote', async () =>
{
    const h = new Harness()
    const d = await h.orchestrator.Run(LoopOrchestrator.ParseCommand(['create-dev', '--graph', Fixture.Graph], Fixture.Stack)) as DevDescriptor
    assert.equal(d.graphName, Fixture.Graph)
    const p = await h.orchestrator.Run(LoopOrchestrator.ParseCommand(['promote', '--graph', Fixture.Graph], Fixture.Stack)) as PromoteDescriptor
    assert.equal(p.graphName, Fixture.Graph)
})
