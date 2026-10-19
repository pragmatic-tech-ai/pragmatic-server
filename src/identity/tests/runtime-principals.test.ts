import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Role, ResourceKind, PresentedSecret, LocalAccount } from '@pragmatic-tech-ai/todl-identity'
import type { ResourceRef } from '@pragmatic-tech-ai/todl-identity'
import type { AdminService } from '../../host/admin-service.js'
import { DeploymentMode } from '../../platform/deployment-mode.js'
import { RuntimePrincipals } from '../runtime-principals.js'

class FakeAdmin
{
    public readonly Accounts: LocalAccount[] = []
    public readonly Grants: { subject: string, role: Role, resource: ResourceRef }[] = []

    public async ListAccounts(): Promise<readonly LocalAccount[]>
    {
        return this.Accounts
    }

    public async CreateAccount(_actor: string, email: string, principalId: string, _password: PresentedSecret): Promise<LocalAccount>
    {
        const account = new LocalAccount(principalId, 't1', email, 'ref', false)
        this.Accounts.push(account)
        return account
    }

    public async GrantRole(_actor: string, subject: string, role: Role, resource: ResourceRef): Promise<void>
    {
        this.Grants.push({ subject, role, resource })
    }

    public AsAdmin(): AdminService
    {
        return this as unknown as AdminService
    }
}

test('SeedReader creates the account with a coarse non-administer grant only', async () =>
{
    const fake = new FakeAdmin()
    await RuntimePrincipals.SeedReader(fake.AsAdmin(), 'admin', 'r@x.io', 'reader', new PresentedSecret('pw'))
    assert.equal(fake.Accounts.length, 1)
    assert.equal(fake.Accounts[0]!.PrincipalId, 'reader')
    assert.equal(fake.Accounts[0]!.Email, 'r@x.io')
    assert.equal(fake.Grants.length, 1)
    assert.equal(fake.Grants[0]!.role, Role.Editor)
    assert.equal(fake.Grants[0]!.resource.Kind, ResourceKind.Tenant)
    assert.equal(fake.Grants[0]!.resource.TenantId, 't1')
})

test('SeedDevAccount creates the dev account and is idempotent', async () =>
{
    const fake = new FakeAdmin()
    await RuntimePrincipals.SeedDevAccount(fake.AsAdmin(), 'admin')
    await RuntimePrincipals.SeedDevAccount(fake.AsAdmin(), 'admin')
    assert.equal(fake.Accounts.length, 1)
    assert.equal(fake.Grants.length, 1)
})

class ModeEnv
{
    private static readonly Key = 'PRAGMATIC_DEPLOYMENT_MODE'

    public static async With(value: string | undefined, body: () => Promise<void>): Promise<void>
    {
        const saved = process.env[ModeEnv.Key]
        if (value === undefined)
        {
            delete process.env[ModeEnv.Key]
        }
        else
        {
            process.env[ModeEnv.Key] = value
        }
        try
        {
            await body()
        }
        finally
        {
            if (saved === undefined)
            {
                delete process.env[ModeEnv.Key]
            }
            else
            {
                process.env[ModeEnv.Key] = saved
            }
        }
    }
}

test('SeedDevAccount refuses when the deployment mode is not local', async () =>
{
    await ModeEnv.With(DeploymentMode.Cloud, async () =>
    {
        const fake = new FakeAdmin()
        await assert.rejects(() => RuntimePrincipals.SeedDevAccount(fake.AsAdmin(), 'admin'), /refused/)
        assert.equal(fake.Accounts.length, 0)
    })
})

test('SeedDevAccount proceeds when the deployment mode is explicitly local', async () =>
{
    await ModeEnv.With(DeploymentMode.Local, async () =>
    {
        const fake = new FakeAdmin()
        await RuntimePrincipals.SeedDevAccount(fake.AsAdmin(), 'admin')
        assert.equal(fake.Accounts.length, 1)
    })
})
