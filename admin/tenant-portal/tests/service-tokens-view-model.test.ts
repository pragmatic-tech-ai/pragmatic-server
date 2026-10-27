import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ServiceTokenRow } from '../src/service-token-row.js'
import { ServiceTokensViewModel, TokenDuration, TokensState } from '../src/service-tokens-view-model.js'
import { TenantApiError } from '../src/tenant-api-client.js'
import { EnvStatus, EnvType, Template } from '../src/tenant-types.js'
import type { ITokensSource, EnvironmentDto, ServiceTokenSummaryDto, IssueTokenParams, TokenIssuedDto } from '../src/tenant-types.js'

class Make
{
    public static Env(name: string): EnvironmentDto
    {
        return { name, template: Template.DevBlank, type: EnvType.Runtime, environmentId: 'id-' + name, hostPort: 1, status: EnvStatus.Running, createdAt: '', httpUrl: '', wsUrl: '' }
    }

    public static Token(ref: string, over: Partial<ServiceTokenSummaryDto> = {}): ServiceTokenSummaryDto
    {
        return { tokenRef: ref, principalId: 'svc', scopes: ['a', 'b'], expiresAt: null, revoked: false, ...over }
    }

    public static Issued(): TokenIssuedDto
    {
        return { tokenRef: 'new', token: 'SECRET', principalId: 'svc', scopes: ['a'], expiresAt: null }
    }
}

class FakeSource implements ITokensSource
{
    public Calls: string[] = []
    public Envs: EnvironmentDto[] = [Make.Env('envA'), Make.Env('envB')]
    public Tokens: ServiceTokenSummaryDto[] = [Make.Token('t1')]
    public ListError: Error | undefined
    public MutationError: Error | undefined
    public Issued: IssueTokenParams | undefined
    public Deferred: Array<(r: ServiceTokenSummaryDto[]) => void> | undefined

    public async ListEnvironments(): Promise<EnvironmentDto[]>
    {
        this.Calls.push('list')
        return this.Envs
    }

    public async ListTokens(env: string): Promise<ServiceTokenSummaryDto[]>
    {
        this.Calls.push('tokens:' + env)
        if (this.Deferred !== undefined)
        {
            const d = this.Deferred
            return new Promise<ServiceTokenSummaryDto[]>(resolve => { d.push(resolve) })
        }
        if (this.ListError !== undefined)
        {
            throw this.ListError
        }
        return this.Tokens
    }

    public async IssueToken(env: string, params: IssueTokenParams): Promise<TokenIssuedDto>
    {
        this.Calls.push('issue:' + env)
        this.Issued = params
        if (this.MutationError !== undefined)
        {
            throw this.MutationError
        }
        return Make.Issued()
    }

    public async RevokeToken(env: string, tokenRef: string): Promise<void>
    {
        this.Calls.push('revoke:' + env + ':' + tokenRef)
        if (this.MutationError !== undefined)
        {
            throw this.MutationError
        }
    }
}

describe('ServiceTokenRow', () =>
{
    it('maps scopes and status', () =>
    {
        const past = new Date(Date.now() - 100000).toISOString()
        const future = new Date(Date.now() + 100000).toISOString()
        const rows = ServiceTokenRow.FromDtos([
            Make.Token('n'),
            Make.Token('f', { expiresAt: future }),
            Make.Token('p', { expiresAt: past }),
            Make.Token('r', { revoked: true, expiresAt: past }),
        ])
        assert.equal(rows[0].ScopesText, 'a, b')
        assert.equal(rows[0].ExpiresText, 'Never')
        assert.equal(rows[0].StatusText, 'Active')
        assert.equal(rows[1].StatusText, 'Active')
        assert.equal(rows[1].ExpiresText, future)
        assert.equal(rows[2].StatusText, 'Expired')
        assert.equal(rows[3].StatusText, 'Revoked')
        assert.equal(rows[3].Revoked, true)
    })
})

describe('ServiceTokensViewModel', () =>
{
    it('loads environments then tokens', async () =>
    {
        const src = new FakeSource()
        const vm = new ServiceTokensViewModel(src)
        await vm.LoadEnvironments()
        assert.equal(vm.SelectedEnvironment, 'envA')
        assert.equal(vm.Rows.length, 1)
        assert.equal(vm.State, TokensState.Ready)
        assert.equal(vm.Busy, false)
    })

    it('empty env list is NoEnvironment and lists no tokens', async () =>
    {
        const src = new FakeSource()
        src.Envs = []
        const vm = new ServiceTokensViewModel(src)
        await vm.LoadEnvironments()
        assert.equal(vm.State, TokensState.NoEnvironment)
        assert.deepEqual(src.Calls, ['list'])
    })

    it('empty token list is Empty', async () =>
    {
        const src = new FakeSource()
        src.Tokens = []
        const vm = new ServiceTokensViewModel(src)
        await vm.LoadEnvironments()
        assert.equal(vm.State, TokensState.Empty)
    })

    it('blank scopes sets Error and does not call the source', async () =>
    {
        const src = new FakeSource()
        const vm = new ServiceTokensViewModel(src)
        await vm.LoadEnvironments()
        src.Calls = []
        vm.DraftScopes = ' , \t '
        await vm.IssueToken()
        assert.notEqual(vm.Error, '')
        assert.deepEqual(src.Calls, [])
    })

    it('issue sets IssuedSecret, clears draft, reloads, parses scopes and duration', async () =>
    {
        const src = new FakeSource()
        const vm = new ServiceTokensViewModel(src)
        await vm.LoadEnvironments()
        src.Calls = []
        vm.DraftPrincipalId = 'svc'
        vm.DraftScopes = 'a, b  c'
        vm.DraftDuration = TokenDuration.ThirtyDays
        await vm.IssueToken()
        assert.deepEqual(src.Issued, { principalId: 'svc', scopes: ['a', 'b', 'c'], expiresInSeconds: 2592000 })
        assert.equal(vm.IssuedSecret?.token, 'SECRET')
        assert.ok(vm.Rows.every(r => !JSON.stringify(r).includes('SECRET')))
        assert.equal(vm.DraftPrincipalId, '')
        assert.equal(vm.DraftScopes, '')
        assert.deepEqual(src.Calls, ['issue:envA', 'tokens:envA'])
        vm.DismissSecret()
        assert.equal(vm.IssuedSecret, undefined)
    })

    it('maps durations to seconds', () =>
    {
        assert.equal(ServiceTokensViewModel.SecondsFor(TokenDuration.OneHour), 3600)
        assert.equal(ServiceTokensViewModel.SecondsFor(TokenDuration.OneDay), 86400)
        assert.equal(ServiceTokensViewModel.SecondsFor(TokenDuration.ThirtyDays), 2592000)
        assert.equal(ServiceTokensViewModel.SecondsFor(TokenDuration.Never), null)
    })

    it('revoke flow: request, cancel, confirm', async () =>
    {
        const src = new FakeSource()
        const vm = new ServiceTokensViewModel(src)
        await vm.LoadEnvironments()
        vm.RequestRevoke('t1')
        assert.equal(vm.Pending, 't1')
        vm.CancelPending()
        assert.equal(vm.Pending, undefined)
        vm.RequestRevoke('t1')
        src.Calls = []
        await vm.ConfirmPending()
        assert.equal(vm.Pending, undefined)
        assert.deepEqual(src.Calls, ['revoke:envA:t1', 'tokens:envA'])
    })

    it('409 on revoke sets Error, rows unchanged, no reload', async () =>
    {
        const src = new FakeSource()
        const vm = new ServiceTokensViewModel(src)
        await vm.LoadEnvironments()
        src.Calls = []
        src.MutationError = new TenantApiError(409, 'conflict')
        vm.RequestRevoke('t1')
        await vm.ConfirmPending()
        assert.equal(vm.Error, 'conflict')
        assert.equal(vm.Rows.length, 1)
        assert.deepEqual(src.Calls, ['revoke:envA:t1'])
        assert.equal(vm.Busy, false)
    })

    it('rethrows 401 on mutation and on load', async () =>
    {
        const src = new FakeSource()
        const vm = new ServiceTokensViewModel(src)
        await vm.LoadEnvironments()
        src.MutationError = new TenantApiError(401, 'no')
        vm.RequestRevoke('t1')
        await assert.rejects(() => vm.ConfirmPending())
        assert.equal(vm.Busy, false)
        src.ListError = new TenantApiError(401, 'no')
        await assert.rejects(() => vm.LoadTokens())
        assert.equal(vm.Busy, false)
    })

    it('non-API load error becomes State=Error', async () =>
    {
        const src = new FakeSource()
        src.ListError = new Error('boom')
        const vm = new ServiceTokensViewModel(src)
        await vm.LoadEnvironments()
        assert.equal(vm.State, TokensState.Error)
        assert.equal(vm.Error, 'boom')
    })

    it('discards a stale overlapping load and keeps Busy until the newest resolves', async () =>
    {
        const src = new FakeSource()
        const vm = new ServiceTokensViewModel(src)
        await vm.LoadEnvironments()
        const pending: Array<(r: ServiceTokenSummaryDto[]) => void> = []
        src.Deferred = pending
        const a = vm.LoadTokens()
        const b = vm.LoadTokens()
        pending[0]([Make.Token('stale1'), Make.Token('stale2')])
        await a
        assert.equal(vm.Busy, true)
        assert.equal(vm.Rows.length, 1)
        assert.equal(vm.Rows[0].TokenRef, 't1')
        pending[1]([Make.Token('fresh')])
        await b
        assert.equal(vm.Busy, false)
        assert.deepEqual(vm.Rows.map(r => r.TokenRef), ['fresh'])
    })

    it('failed issue keeps drafts, leaves no secret, and does not reload', async () =>
    {
        const src = new FakeSource()
        const vm = new ServiceTokensViewModel(src)
        await vm.LoadEnvironments()
        src.Calls = []
        src.MutationError = new TenantApiError(409, 'exists')
        vm.DraftPrincipalId = 'svc'
        vm.DraftScopes = 'a b'
        await vm.IssueToken()
        assert.equal(vm.IssuedSecret, undefined)
        assert.equal(vm.DraftPrincipalId, 'svc')
        assert.equal(vm.DraftScopes, 'a b')
        assert.equal(vm.Error, 'exists')
        assert.deepEqual(src.Calls, ['issue:envA'])
    })

    it('SelectEnvironment clears a stale IssuedSecret', async () =>
    {
        const src = new FakeSource()
        const vm = new ServiceTokensViewModel(src)
        await vm.LoadEnvironments()
        vm.DraftPrincipalId = 'svc'
        vm.DraftScopes = 'a'
        await vm.IssueToken()
        assert.notEqual(vm.IssuedSecret, undefined)
        await vm.SelectEnvironment('envB')
        assert.equal(vm.IssuedSecret, undefined)
    })
})
