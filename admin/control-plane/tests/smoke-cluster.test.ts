import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SmokeCluster } from '../smoke-cluster.js'

class SmokeClusterFx
{
    public static readonly KindContext = 'kind-pragmatic-images'
    public static readonly KindNode = 'pragmatic-images-control-plane'
    public static readonly OtherContext = 'minikube'
    public static readonly ExplicitNode = 'my-node'
    public static readonly Empty = ''
}

test('with nothing set, the smokes target Docker Desktop\'s built-in Kubernetes as before', () =>
{
    assert.equal(SmokeCluster.Context({}), SmokeCluster.DefaultContext)
    assert.equal(SmokeCluster.Node({}), SmokeCluster.DefaultNode)
})

test('an empty setting counts as unset', () =>
{
    const env = { [SmokeCluster.ContextEnv]: SmokeClusterFx.Empty, [SmokeCluster.NodeEnv]: SmokeClusterFx.Empty }
    assert.equal(SmokeCluster.Context(env), SmokeCluster.DefaultContext)
    assert.equal(SmokeCluster.Node(env), SmokeCluster.DefaultNode)
})

test('a kind context implies its control-plane node container', () =>
{
    const env = { [SmokeCluster.ContextEnv]: SmokeClusterFx.KindContext }
    assert.equal(SmokeCluster.Context(env), SmokeClusterFx.KindContext)
    assert.equal(SmokeCluster.Node(env), SmokeClusterFx.KindNode)
})

test('an explicit node wins, and a non-kind context keeps the default node', () =>
{
    assert.equal(SmokeCluster.Node({ [SmokeCluster.ContextEnv]: SmokeClusterFx.KindContext, [SmokeCluster.NodeEnv]: SmokeClusterFx.ExplicitNode }), SmokeClusterFx.ExplicitNode)
    assert.equal(SmokeCluster.Node({ [SmokeCluster.ContextEnv]: SmokeClusterFx.OtherContext }), SmokeCluster.DefaultNode)
})
