import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ActivityViewModel } from '../src/activity-view-model.js'
import { PillTone } from '../src/kit/index.js'
import type { ActivityDto } from '../src/portal-types.js'

class Fx
{
    public static Entry(method: string, path: string, status: number): ActivityDto
    {
        return { id: 'a1', actor: 'op@example.com', method, path, status, at: '2026-01-02T03:04:05Z' }
    }
}

describe('ActivityViewModel', () =>
{
    it('labels a publish and tones a 201 as success', () =>
    {
        const row = new ActivityViewModel([Fx.Entry('POST', '/api/manifests', 201)]).Rows[0]
        assert.equal(row.actionLabel, 'Published a version')
        assert.equal(row.tone, PillTone.Success)
        assert.equal(row.status, 201)
        assert.equal(row.actor, 'op@example.com')
        assert.ok(row.whenLabel.length > 0)
    })

    it('labels a tenant hold and a release', () =>
    {
        const rows = new ActivityViewModel([
            Fx.Entry('POST', '/api/tenants/t1/policy/hold', 200),
            Fx.Entry('DELETE', '/api/tenants/t1/policy/hold', 200),
        ]).Rows
        assert.equal(rows[0].actionLabel, 'Held a tenant')
        assert.equal(rows[1].actionLabel, 'Released a tenant')
    })

    it('tones denied and anonymous attempts as warning', () =>
    {
        const rows = new ActivityViewModel([
            Fx.Entry('POST', '/api/manifests', 403),
            Fx.Entry('POST', '/api/manifests', 401),
            Fx.Entry('POST', '/api/manifests', 500),
        ]).Rows
        assert.deepEqual(rows.map(r => r.tone), [PillTone.Warning, PillTone.Warning, PillTone.Warning])
    })

    it('labels the body-keyed operator mutation routes (no id in the path)', () =>
    {
        const rows = new ActivityViewModel([
            Fx.Entry('POST', '/api/operators/role', 200),
            Fx.Entry('POST', '/api/operators/password-reset', 200),
            Fx.Entry('POST', '/api/operators/disabled', 200),
            Fx.Entry('POST', '/api/operators/revoke-sessions', 200),
        ]).Rows
        assert.deepEqual(rows.map(r => r.actionLabel), ['Changed an operator role', 'Reset a password', 'Enabled or disabled an operator', 'Revoked sessions'])
    })

    it('falls back to the raw method and path when unmatched', () =>
    {
        assert.equal(new ActivityViewModel([Fx.Entry('PATCH', '/api/x', 200)]).Rows[0].actionLabel, 'PATCH /api/x')
    })

    it('Update replaces rows and raises a change', () =>
    {
        const vm = new ActivityViewModel([])
        const seen: string[] = []
        vm.PropertyChanged(ActivityViewModel.RowsProperty).subscribe(() => { seen.push(ActivityViewModel.RowsProperty) })
        vm.Update([Fx.Entry('POST', '/api/provision', 200)])
        assert.equal(vm.Rows[0].actionLabel, 'Provisioned')
        assert.deepEqual(seen, [ActivityViewModel.RowsProperty])
    })
})
