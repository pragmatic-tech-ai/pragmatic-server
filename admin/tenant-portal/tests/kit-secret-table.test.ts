import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TextBlock } from '@pragmatic-tech-ai/mural/basic'
import { Application } from '@pragmatic-tech-ai/mural/runtime'
import { Pragmatic, PragmaticLight } from '@pragmatic-tech-ai/mural/resources/pragmatic'
import { PillKind, SecretTable, StatusPill } from '../src/kit/index.js'
import type { SecretRow } from '../src/kit/index.js'

class Fixtures
{
    public static readonly Need = 'the Manage users & access permission'

    public static Collect(node: unknown, out: unknown[] = []): unknown[]
    {
        out.push(node)
        const children = (node as { Children?: Iterable<unknown> }).Children
        if (children !== undefined)
        {
            for (const c of children)
            {
                Fixtures.Collect(c, out)
            }
        }
        return out
    }

    public static Texts(node: unknown): string[]
    {
        return Fixtures.Collect(node).filter(n => n instanceof TextBlock).map(n => (n as TextBlock).Text)
    }

    public static Pills(node: unknown): StatusPill[]
    {
        return Fixtures.Collect(node).filter(n => n instanceof StatusPill) as StatusPill[]
    }

    public static Rows(): SecretRow[]
    {
        return [
            { reference: 'tok_ref_1', note: 'CI deploy', status: PillKind.Active, revoked: false },
            { reference: 'tok_ref_2', status: PillKind.Revoked, revoked: true },
        ]
    }
}

describe('SecretTable', () =>
{
    let previous: Application | null

    before(() =>
    {
        previous = Application.current
        const app = new Application()
        Application.current = app
        app.initialize({ theme: Pragmatic, scheme: PragmaticLight })
    })

    after(() =>
    {
        Application.current = previous
    })

    it('renders one row per secret with reference, note and status pill', () =>
    {
        const t = new SecretTable({ rows: Fixtures.Rows(), canRevoke: true, onRevoke: () => {} })
        assert.equal(t.RowCount, 2)
        assert.equal(t.ReferenceAt(0), 'tok_ref_1')
        assert.equal(t.ReferenceAt(1), 'tok_ref_2')
        const texts = Fixtures.Texts(t)
        assert.ok(texts.includes('tok_ref_1'))
        assert.ok(texts.includes('CI deploy'))
        const pills = Fixtures.Pills(t)
        assert.equal(pills.length, 2)
        assert.equal(pills[0].Kind, PillKind.Active)
        assert.equal(pills[1].Kind, PillKind.Revoked)
    })

    it('Revoke is enabled when canRevoke and the row is live', () =>
    {
        const calls: string[] = []
        const t = new SecretTable({ rows: Fixtures.Rows(), canRevoke: true, onRevoke: r => { calls.push(r) } })
        assert.equal(t.RevokeAct(0).Enabled, true)
        t.RevokeAct(0).Press()
        assert.deepEqual(calls, ['tok_ref_1'])
    })

    it('Revoke is disabled and names the permission when denied', () =>
    {
        const t = new SecretTable({ rows: Fixtures.Rows(), canRevoke: false, need: Fixtures.Need, onRevoke: () => {} })
        assert.equal(t.RevokeAct(0).Enabled, false)
        assert.ok(t.RevokeAct(0).DisabledHint?.includes(Fixtures.Need))
    })

    it('a revoked row cannot be revoked again', () =>
    {
        const t = new SecretTable({ rows: Fixtures.Rows(), canRevoke: true, onRevoke: () => {} })
        assert.equal(t.RevokeAct(1).Enabled, false)
    })
})
