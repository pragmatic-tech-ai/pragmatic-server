import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EnvType, Template } from '../../environment-record.js'
import { KubectlLoopDatabase, LoopApiAnswers, StackLoopGraphs, TenantApiLoopEnvironments, type ILoopApi } from '../loop-stack-adapters.js'
import type { ApiAnswer } from '../operator-api-client.js'

class RecordingApi implements ILoopApi
{
    public readonly calls: { method: string; path: string; body: unknown }[] = []

    public constructor(private readonly answer: (method: string, path: string) => ApiAnswer = () => ({ status: 200, body: {} }))
    {
    }

    public async Call(method: string, path: string, body?: unknown): Promise<ApiAnswer>
    {
        this.calls.push({ method, path, body })
        return this.answer(method, path)
    }
}

test('LoopApiAnswers passes a 2xx and turns anything else into an error with the operation, status and server error text', () =>
{
    const ok = { status: 201, body: {} }
    assert.equal(LoopApiAnswers.Require(ok, 'op'), ok)
    assert.throws(() => LoopApiAnswers.Require({ status: 409, body: { error: 'exists' } }, 'environment create'), /^Error: environment create failed: status 409: exists$/)
    assert.throws(() => LoopApiAnswers.Require({ status: 500, body: undefined }, 'promote'), /^Error: promote failed: status 500$/)
})

test('TenantApiLoopEnvironments: create, the admin leaves and the security PUT body follow the tenant API routes', async () =>
{
    const api = new RecordingApi(() => ({ status: 201, body: { name: 'loop-rt', environmentId: 'loop-rt', status: 'running' } }))
    const envs = new TenantApiLoopEnvironments(api)
    assert.deepEqual(await envs.Create('loop-rt', Template.RuntimePostgres, EnvType.Runtime), { name: 'loop-rt', environmentId: 'loop-rt', status: 'running' })
    await envs.AdminCreateAccount('loop-rt', { email: 'r@t.io', principalId: 'r', password: 'p' } as never)
    await envs.AdminGrantRole('loop-rt', { subject: 'r', role: 'Viewer' } as never)
    await envs.AdminSetSecurityModel('loop-rt', { businessUnits: [] } as never)
    assert.deepEqual(api.calls.map(c => c.method + ' ' + c.path), [
        'POST /tenant-api/environments',
        'POST /tenant-api/environments/loop-rt/admin/accounts',
        'POST /tenant-api/environments/loop-rt/admin/grants',
        'PUT /tenant-api/environments/loop-rt/admin/security-model',
    ])
    assert.deepEqual(api.calls[0]!.body, { name: 'loop-rt', template: 'runtime-postgres', type: 'runtime' })
    assert.deepEqual(api.calls[3]!.body, { securityModel: { businessUnits: [] } })
})

test('TenantApiLoopEnvironments.Delete answers false for an absent environment and true for a deleted one', async () =>
{
    assert.equal(await new TenantApiLoopEnvironments(new RecordingApi(() => ({ status: 404, body: undefined }))).Delete('loop-dev'), false)
    assert.equal(await new TenantApiLoopEnvironments(new RecordingApi(() => ({ status: 204, body: undefined }))).Delete('loop-dev'), true)
    await assert.rejects(new TenantApiLoopEnvironments(new RecordingApi(() => ({ status: 500, body: undefined }))).Delete('loop-dev'))
})

test('StackLoopGraphs creates the graph as the owner and promotes as the operator', async () =>
{
    const owner = new RecordingApi(() => ({ status: 201, body: {} }))
    const operator = new RecordingApi(() => ({ status: 200, body: { graphName: 'g', packageCount: 2, targetEnv: 'loop-rt' } }))
    const graphs = new StackLoopGraphs(owner, operator)
    await graphs.Create('loop-dev', 'g', 'd')
    assert.deepEqual(await graphs.Promote('loop-dev', 'g', 'loop-rt'), { graphName: 'g', packageCount: 2, targetEnv: 'loop-rt' })
    assert.deepEqual(owner.calls, [{ method: 'POST', path: '/tenant-api/environments/loop-dev/graphs', body: { name: 'g', description: 'd' } }])
    assert.deepEqual(operator.calls, [{ method: 'POST', path: '/api/environments/loop-dev/graphs/g/promote', body: { targetEnv: 'loop-rt' } }])
})

test('KubectlLoopDatabase runs psql in the env database pod with the SQL as an argument and reads the last command tag', async () =>
{
    const runs: { file: string; args: readonly string[] }[] = []
    const db = new KubectlLoopDatabase('kind-x', { Run: async (file, args) => { runs.push({ file, args }); return { stdout: 'CREATE TABLE\nINSERT 0 1\n', stderr: '' } } })
    assert.equal(await db.Exec('loop-rt', 'SELECT 1'), 1)
    assert.equal(runs[0]!.file, 'kubectl')
    assert.deepEqual(runs[0]!.args.slice(0, 6), ['--context', 'kind-x', '-n', 'pragmatic-env-loop-rt', 'exec', 'pragmatic-env-loop-rt-postgres-0'])
    assert.equal(runs[0]!.args[runs[0]!.args.length - 1], 'SELECT 1')
    assert.equal(KubectlLoopDatabase.RowCountOf('UPDATE 3\n'), 3)
    assert.equal(KubectlLoopDatabase.RowCountOf('CREATE TABLE\n'), 0)
})

test('KubectlLoopDatabase reports only psql ERROR lines on failure, never the command line or the statement', async () =>
{
    const sql = "INSERT INTO t VALUES ('secretish')"
    const db = new KubectlLoopDatabase('kind-x', { Run: async () => { throw new Error('Command failed: kubectl exec ... ' + sql + '\nERROR:  relation "t" does not exist\nLINE 1: ' + sql) } })
    await assert.rejects(db.Exec('loop-rt', sql), (err: Error) => err.message === 'psql in the environment database failed: ERROR:  relation "t" does not exist' && !err.message.includes(sql))
})
