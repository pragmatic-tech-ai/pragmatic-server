import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdpRealmSet, ReservedRealmError } from '../idp-host.js';
import type { RealmFactory } from '../idp-host.js';
import type { IdpRealm } from '../idp-realm.js';

class RealmSetFixture
{
    public static readonly Display = 'Display';
    public static readonly BadKeys = ['_admin', '_x', '', '../x', 'a/b', 'a/../b', '..', 'a\\b'];

    public calls = 0;

    public FakeRealm(): IdpRealm
    {
        return {} as unknown as IdpRealm;
    }

    public Factory(): RealmFactory
    {
        return async () =>
        {
            this.calls++;
            return this.FakeRealm();
        };
    }
}

test('EnsureRealm creates once then returns the same realm', async () =>
{
    const f = new RealmSetFixture();
    const set = new IdpRealmSet([], f.Factory());
    const a = await set.EnsureRealm('t1', RealmSetFixture.Display);
    const b = await set.EnsureRealm('t1', RealmSetFixture.Display);
    assert.equal(a, b);
    assert.equal(f.calls, 1);
    assert.equal(set.For('t1'), a);
});

test('EnsureRealm returns a pre-registered realm without invoking the factory', async () =>
{
    const f = new RealmSetFixture();
    const existing = f.FakeRealm();
    const set = new IdpRealmSet([['t1', existing]], f.Factory());
    assert.equal(await set.EnsureRealm('t1', RealmSetFixture.Display), existing);
    assert.equal(f.calls, 0);
});

test('EnsureRealm rejects reserved or malformed keys with ReservedRealmError', async () =>
{
    const f = new RealmSetFixture();
    const set = new IdpRealmSet([], f.Factory());
    for (const key of RealmSetFixture.BadKeys)
    {
        await assert.rejects(() => set.EnsureRealm(key, RealmSetFixture.Display), ReservedRealmError);
    }
    assert.equal(f.calls, 0);
});

test('EnsureRealm without a factory for a new key throws', async () =>
{
    const set = new IdpRealmSet();
    await assert.rejects(() => set.EnsureRealm('t1', RealmSetFixture.Display), /unsupported/);
});

test('concurrent EnsureRealm for one new key runs the factory once and returns one instance', async () =>
{
    const f = new RealmSetFixture();
    const set = new IdpRealmSet([], f.Factory());
    const [a, b] = await Promise.all([
        set.EnsureRealm('t1', RealmSetFixture.Display),
        set.EnsureRealm('t1', RealmSetFixture.Display)
    ]);
    assert.equal(f.calls, 1);
    assert.equal(a, b);
});

test('a rejecting factory is not cached - a later EnsureRealm can retry', async () =>
{
    const f = new RealmSetFixture();
    const set = new IdpRealmSet([], async () =>
    {
        f.calls++;
        if (f.calls === 1)
        {
            throw new Error('boom');
        }
        return f.FakeRealm();
    });
    await assert.rejects(() => set.EnsureRealm('t1', RealmSetFixture.Display), /boom/);
    const realm = await set.EnsureRealm('t1', RealmSetFixture.Display);
    assert.equal(set.For('t1'), realm);
    assert.equal(f.calls, 2);
});
