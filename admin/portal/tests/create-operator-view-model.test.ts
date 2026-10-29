import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CreateOperatorViewModel } from '../src/create-operator-view-model.js'

class FakeSink
{
    public Calls: unknown[][] = []
    public Fail: Error | undefined

    public async CreateOperator(email: string, password: string, role: string): Promise<void>
    {
        this.Calls.push(['CreateOperator', email, password, role])
        if (this.Fail)
        {
            throw this.Fail
        }
    }
}

describe('CreateOperatorViewModel', () =>
{
    it('CanSubmit requires email, password and role', () =>
    {
        const vm = new CreateOperatorViewModel(new FakeSink())
        assert.equal(vm.CanSubmit('', 'pw', 'readonly'), false)
        assert.equal(vm.CanSubmit('  ', 'pw', 'readonly'), false)
        assert.equal(vm.CanSubmit('a@x', '', 'readonly'), false)
        assert.equal(vm.CanSubmit('a@x', 'pw', ''), false)
        assert.equal(vm.CanSubmit('a@x', 'pw', 'readonly'), true)
    })

    it('Submit trims the email and passes the password verbatim', async () =>
    {
        const fake = new FakeSink()
        const vm = new CreateOperatorViewModel(fake)
        await vm.Submit(' a@x ', ' pw ', 'readonly')
        assert.deepEqual(fake.Calls, [['CreateOperator', 'a@x', ' pw ', 'readonly']])
        assert.equal(vm.Busy, false)
        assert.equal(vm.ErrorMessage, '')
    })

    it('Submit surfaces a sink error and clears busy', async () =>
    {
        const fake = new FakeSink()
        fake.Fail = new Error('boom')
        const vm = new CreateOperatorViewModel(fake)
        await assert.rejects(() => vm.Submit('a@x', 'pw', 'readonly'), /boom/)
        assert.equal(vm.ErrorMessage, 'boom')
        assert.equal(vm.Busy, false)
    })
})
