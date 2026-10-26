import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OperatorAuthorization } from '../operator-authorization.js'
import { OperatorRole } from '../operator-identity.js'

class AuthorizationFixture
{
    public static readonly Mutating: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE']
    public static readonly Safe: readonly string[] = ['GET', 'HEAD', 'OPTIONS']
    public static readonly ResourcePaths: readonly string[] = ['/api/clients', '/api/operators', '/api/environments/x/start', '/api/manifests']
    public static readonly ReadPath = '/api/environments'
    public static readonly Logout = '/api/logout'
}

describe('OperatorAuthorization', () =>
{
    const authz = new OperatorAuthorization()

    it('blocks ReadOnly on every mutating method for resource routes', () =>
    {
        for (const method of AuthorizationFixture.Mutating)
        {
            for (const path of AuthorizationFixture.ResourcePaths)
            {
                assert.equal(authz.Authorize(OperatorRole.ReadOnly, method, path), false, `${method} ${path}`)
            }
        }
    })

    it('allows ReadOnly on safe methods', () =>
    {
        for (const method of AuthorizationFixture.Safe)
        {
            assert.equal(authz.Authorize(OperatorRole.ReadOnly, method, AuthorizationFixture.ReadPath), true, method)
        }
    })

    it('always allows logout for ReadOnly', () =>
    {
        assert.equal(authz.Authorize(OperatorRole.ReadOnly, 'POST', AuthorizationFixture.Logout), true)
    })

    it('allows Full everywhere', () =>
    {
        for (const method of [...AuthorizationFixture.Mutating, ...AuthorizationFixture.Safe])
        {
            for (const path of [...AuthorizationFixture.ResourcePaths, AuthorizationFixture.ReadPath, AuthorizationFixture.Logout])
            {
                assert.equal(authz.Authorize(OperatorRole.Full, method, path), true, `${method} ${path}`)
            }
        }
    })
})
