import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WikiOriginKind } from '@pragmatic-tech-ai/todl'
import type { WikiOrigin } from '@pragmatic-tech-ai/todl'
import { WikiOriginWire } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { WikiOriginWireMapper } from '../wiki-origin-wire.js'

class OriginFx
{
    public static readonly Root = 'env/src/Alpha/models'
    public static readonly Elsewhere = 'env/src/Alpha/other'
    public static readonly MemberPath = 'models'

    public static Storage(root: string): IStorage
    {
        return { Root: root } as unknown as IStorage
    }

    public static Open(root: string): WikiOrigin
    {
        return { kind: WikiOriginKind.OpenProject, storage: OriginFx.Storage(root) } as unknown as WikiOrigin
    }
}

test('an open-project origin resolves by storage Root, so a re-created handle for the same root still maps', () =>
{
    const mapper = new WikiOriginWireMapper([{ Ref: { path: OriginFx.MemberPath }, Storage: OriginFx.Storage(OriginFx.Root) }])
    assert.deepEqual(mapper.Of(OriginFx.Open(OriginFx.Root)), { kind: WikiOriginWire.OpenProject, memberId: OriginFx.MemberPath })
})

test('an origin whose storage root is no member has no wire form (fail-safe)', () =>
{
    const mapper = new WikiOriginWireMapper([{ Ref: { path: OriginFx.MemberPath }, Storage: OriginFx.Storage(OriginFx.Root) }])
    assert.equal(mapper.Of(OriginFx.Open(OriginFx.Elsewhere)), undefined)
})
