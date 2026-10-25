import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentWiring } from '../agent-wiring.js'

const Base = 'https://platform.example.com'
const MissingKey = 'PRAGMATIC_AGENT_TEST_MISSING_KEY'
const MissingMessage = 'missing required environment variable PRAGMATIC_AGENT_TEST_MISSING_KEY'

test('label selector is hive equality AND environment-label presence', () =>
{
    assert.equal(AgentWiring.LabelSelector('h-1'), 'pragmatic/hive=h-1,pragmatic/environment')
})

test('target and snapshot URLs use the agent channel paths', () =>
{
    assert.equal(AgentWiring.TargetUrl(Base, 'h-1'), 'https://platform.example.com/agent/hives/h-1/target')
    assert.equal(AgentWiring.SnapshotUrl(Base, 'h-1'), 'https://platform.example.com/agent/hives/h-1/snapshot')
})

test('URL builders encode the hive id', () =>
{
    assert.equal(AgentWiring.TargetUrl(Base, 'a b/c'), 'https://platform.example.com/agent/hives/a%20b%2Fc/target')
})

test('environment name strips the pragmatic-env- prefix', () =>
{
    assert.equal(AgentWiring.EnvironmentName('pragmatic-env-prod'), 'prod')
    assert.equal(AgentWiring.EnvironmentName('other-ns'), 'other-ns')
})

test('ToEnvironmentState maps a server deployment', () =>
{
    const state = AgentWiring.ToEnvironmentState({ namespace: 'pragmatic-env-dev', deployment: 'd', container: 'server', runningImage: 'img:1', ready: true })
    assert.deepEqual(state, { environmentName: 'dev', namespace: 'pragmatic-env-dev', deployment: 'd', container: 'server', runningImage: 'img:1', ready: true })
})

test('Required throws the fixed message for a missing env var', () =>
{
    delete process.env[MissingKey]
    assert.throws(() => AgentWiring.Required(MissingKey), new Error(MissingMessage))
})

test('environment name edge cases: bare prefix yields empty, unprefixed is unchanged', () =>
{
    assert.equal(AgentWiring.EnvironmentName('pragmatic-env-'), '')
    assert.equal(AgentWiring.EnvironmentName('kube-system'), 'kube-system')
})
