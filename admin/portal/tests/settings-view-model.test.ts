import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SettingsViewModel } from '../src/settings-view-model.js'

describe('SettingsViewModel', () =>
{
    it('keeps the session values and starts with no rows', () =>
    {
        const vm = new SettingsViewModel({ email: 'me@example.com', roleLabel: 'Operator' })
        assert.equal(vm.Email, 'me@example.com')
        assert.equal(vm.RoleLabel, 'Operator')
        assert.equal(vm.Rows.length, 0)
    })

    it('maps role labels and sorts rows by email', () =>
    {
        const vm = new SettingsViewModel({ email: 'me@example.com', roleLabel: 'Operator' })
        let raised = 0
        vm.PropertyChanged(SettingsViewModel.RowsProperty).subscribe(() => { raised++ })
        vm.Update([
            { email: 'zed@example.com', role: 'readonly' },
            { email: 'amy@example.com', role: 'full' },
        ])
        assert.deepEqual(vm.Rows, [
            { email: 'amy@example.com', roleLabel: 'Operator' },
            { email: 'zed@example.com', roleLabel: 'Observer' },
        ])
        assert.ok(raised > 0)
        assert.equal(vm.Email, 'me@example.com')
    })

    it('an empty roster yields no rows', () =>
    {
        const vm = new SettingsViewModel({ email: 'me@example.com', roleLabel: 'Observer' })
        vm.Update([{ email: 'a@example.com', role: 'full' }])
        vm.Update([])
        assert.equal(vm.Rows.length, 0)
        assert.equal(vm.RoleLabel, 'Observer')
    })
})
