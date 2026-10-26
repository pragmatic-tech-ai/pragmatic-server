import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InClusterRegistry } from '../in-cluster-registry.js'

test('PullBase is the cluster Service DNS on the service port', () =>
{
    assert.equal(InClusterRegistry.PullBase(), 'pragmatic-registry.pragmatic-system.svc.cluster.local:5000')
})

test('PushBase is the host loopback on the node port', () =>
{
    assert.equal(InClusterRegistry.PushBase(), 'localhost:30500')
})

test('NodePort is inside the kubernetes NodePort range', () =>
{
    assert.ok(InClusterRegistry.NodePort >= 30000 && InClusterRegistry.NodePort <= 32767)
})

test('the registry image is pinned to registry:2', () =>
{
    assert.equal(InClusterRegistry.Image, 'registry:2')
})
