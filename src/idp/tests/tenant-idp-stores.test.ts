import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing';
import { SqlIdpClientStore } from '../sql-idp-client-store.js';
import { SqlIdpRealmCatalogue } from '../sql-idp-realm-catalogue.js';
import { SqlIdpAccountProfiles } from '../sql-idp-account-profiles.js';
import { SqlIdpFederatedAccounts } from '../sql-idp-federated-accounts.js';
import { AuthorizationGrant, SqlAuthorizationCodeStore } from '../sql-authorization-code-store.js';
import { SqlSsoSessionStore } from '../sql-sso-session-store.js';
import { RefreshOutcome, SqlRefreshTokenStore } from '../sql-refresh-token-store.js';
import { RealmSignIn } from '../realm-sign-in.js';
import { TokenPolicy } from '../realm-settings.js';

class StoreFixture
{
    public static readonly Realm = 'tenant-1';
    public static readonly OtherRealm = 'tenant-2';
    public static readonly Client = 'console';
    public static readonly OtherClient = 'ledger';
    public static readonly Redirect = 'https://console.example/cb';
    public static readonly Secret = 'client-secret-1';
    public static readonly Account = 'acc-1';
    public static readonly HourMs = 60 * 60 * 1000;

    public static SignIn(at: Date = new Date()): RealmSignIn
    {
        return new RealmSignIn(StoreFixture.Account, 'local', StoreFixture.Account, ['staff'], 'a@example.com', 'Ada', undefined, at);
    }

    public static Policy(idleMs: number = StoreFixture.HourMs, maxMs: number = 24 * StoreFixture.HourMs): TokenPolicy
    {
        return new TokenPolicy(5 * 60 * 1000, idleMs, maxMs, 8 * StoreFixture.HourMs);
    }
}

SqlTestSessions.Describe('realm sign-in service stores', (makeSession, label) =>
{
    describe(label, () =>
    {
        it('registers, finds and authenticates clients by realm; a rotated secret replaces the old', async () =>
        {
            const F = StoreFixture;
            const clients = await SqlIdpClientStore.Open(await makeSession());
            await clients.Register(F.Realm, F.Client, [F.Redirect], F.Secret, ['https://console.example/']);
            const found = await clients.Find(F.Realm, F.Client);
            assert.deepEqual(found?.RedirectUris, [F.Redirect]);
            assert.equal(found?.PostLogoutAllowed('https://console.example/'), true);
            assert.equal(found?.PostLogoutAllowed('https://evil.example/'), false);
            assert.equal(await clients.Find(F.OtherRealm, F.Client), undefined);
            assert.notEqual(await clients.Authenticate(F.Realm, F.Client, F.Secret), undefined);
            assert.equal(await clients.Authenticate(F.Realm, F.Client, 'wrong'), undefined);
            await clients.Register(F.Realm, F.Client, [F.Redirect], 'rotated');
            assert.equal(await clients.Authenticate(F.Realm, F.Client, F.Secret), undefined);
            assert.equal(await clients.Remove(F.Realm, F.Client), true);
            assert.equal(await clients.Remove(F.Realm, F.Client), false);
        });

        it('keeps the realm catalogue and account profiles', async () =>
        {
            const F = StoreFixture;
            const session = await makeSession();
            const catalogue = await SqlIdpRealmCatalogue.Open(session);
            await catalogue.Record(F.Realm, 'One');
            await catalogue.Record(F.Realm, 'Renamed');
            assert.deepEqual((await catalogue.Entries()).map(e => [e.RealmId, e.DisplayName]), [[F.Realm, 'Renamed']]);
            const profiles = await SqlIdpAccountProfiles.Open(session);
            assert.equal(await profiles.CredentialsChangedAt(F.Realm, F.Account), undefined);
            await profiles.PutName(F.Realm, F.Account, 'Ada');
            const at = new Date('2026-11-20T10:00:00Z');
            await profiles.StampCredentialsChanged(F.Realm, F.Account, at);
            assert.equal(await profiles.Name(F.Realm, F.Account), 'Ada');
            assert.equal((await profiles.CredentialsChangedAt(F.Realm, F.Account))?.getTime(), at.getTime());
        });

        it('links an upstream identity to one stable account and follows its email', async () =>
        {
            const F = StoreFixture;
            const federated = await SqlIdpFederatedAccounts.Open(await makeSession());
            const first = await federated.Link(F.Realm, 'google', 'g-1', 'a@example.com', 'Ada');
            const again = await federated.Link(F.Realm, 'google', 'g-1', 'ada@example.com', 'Ada L');
            assert.equal(again.AccountId, first.AccountId);
            assert.equal(again.Email, 'ada@example.com');
            const other = await federated.Link(F.Realm, 'entra', 'g-1', 'a@example.com', 'Ada');
            assert.notEqual(other.AccountId, first.AccountId);
            assert.equal((await federated.ByAccount(F.Realm, first.AccountId))?.Subject, 'g-1');
        });

        it('takes an authorization code once, and never an expired one', async () =>
        {
            const F = StoreFixture;
            let now = new Date('2026-11-20T10:00:00Z');
            const codes = await SqlAuthorizationCodeStore.Open(await makeSession(), () => now);
            const grant = new AuthorizationGrant(F.Realm, F.Client, F.Redirect, 'nonce', 'challenge', F.SignIn(now), 'sso-hash');
            const code = await codes.Issue(grant);
            const taken = (await codes.Take(code)).Grant;
            assert.equal(taken?.ClientId, F.Client);
            assert.equal(taken?.SignIn.AccountId, F.Account);
            assert.equal(taken?.SsoIdHash, 'sso-hash');
            await codes.RecordFamily(code, 'family-1');
            const replay = await codes.Take(code);
            assert.equal(replay.Grant, undefined);
            assert.equal(replay.Replayed, true);
            assert.equal(replay.ReplayedFamily, 'family-1');
            assert.equal((await codes.Take('never-issued')).Replayed, false);
            const late = await codes.Issue(grant);
            now = new Date(now.getTime() + SqlAuthorizationCodeStore.CodeTtlMs + 1);
            assert.equal((await codes.Take(late)).Grant, undefined);
        });

        it('validates SSO sessions per realm, ends them, and expires them', async () =>
        {
            const F = StoreFixture;
            let now = new Date('2026-11-20T10:00:00Z');
            const sso = await SqlSsoSessionStore.Open(await makeSession(), () => now);
            const issued = await sso.Issue(F.Realm, F.SignIn(now), F.HourMs);
            assert.equal((await sso.Validate(issued.Id, F.Realm))?.SignIn.Email, 'a@example.com');
            assert.equal(await sso.Validate(issued.Id, F.OtherRealm), undefined);
            const kept = await sso.Issue(F.Realm, F.SignIn(now), F.HourMs);
            assert.equal(await sso.RevokeAccount(F.Realm, F.Account, kept.Session.IdHash), 1);
            assert.equal(await sso.Validate(issued.Id, F.Realm), undefined);
            assert.notEqual(await sso.Validate(kept.Id, F.Realm), undefined);
            now = new Date(now.getTime() + F.HourMs + 1);
            assert.equal(await sso.Validate(kept.Id, F.Realm), undefined);
        });

        it('rotates refresh tokens, detects reuse and revokes the family', async () =>
        {
            const F = StoreFixture;
            const now = new Date('2026-11-20T10:00:00Z');
            const tokens = await SqlRefreshTokenStore.Open(await makeSession(), () => now);
            const first = (await tokens.IssueFamily(F.Realm, F.Client, F.SignIn(now), 'sso-hash', F.Policy(), F.Policy().RefreshMaxMs)).Token;
            assert.equal((await tokens.Redeem(first, F.Realm, F.OtherClient)).Outcome, RefreshOutcome.Invalid);
            const redeemed = await tokens.Redeem(first, F.Realm, F.Client);
            assert.equal(redeemed.Outcome, RefreshOutcome.Redeemed);
            const second = (await tokens.Rotate(redeemed.Grant!, F.SignIn(now), F.Policy()))!;
            assert.equal((await tokens.Redeem(first, F.Realm, F.Client)).Outcome, RefreshOutcome.Reused);
            assert.equal((await tokens.Redeem(second, F.Realm, F.Client)).Outcome, RefreshOutcome.Invalid);
            assert.equal(await tokens.Rotate(redeemed.Grant!, F.SignIn(now), F.Policy()), undefined, 'a rotation racing the revocation issues nothing');
        });

        it('expires refresh tokens idle and at the family end, and revokes by SSO session, account and token', async () =>
        {
            const F = StoreFixture;
            let now = new Date('2026-11-20T10:00:00Z');
            const tokens = await SqlRefreshTokenStore.Open(await makeSession(), () => now);
            const idle = (await tokens.IssueFamily(F.Realm, F.Client, F.SignIn(now), undefined, F.Policy(F.HourMs, 2 * F.HourMs), F.Policy(F.HourMs, 2 * F.HourMs).RefreshMaxMs)).Token;
            const bySso = (await tokens.IssueFamily(F.Realm, F.Client, F.SignIn(now), 'sso-1', F.Policy(), F.Policy().RefreshMaxMs)).Token;
            const byAccount = (await tokens.IssueFamily(F.Realm, F.Client, F.SignIn(now), undefined, F.Policy(10 * F.HourMs), F.Policy(10 * F.HourMs).RefreshMaxMs)).Token;
            const byToken = (await tokens.IssueFamily(F.Realm, F.Client, F.SignIn(now), undefined, F.Policy(), F.Policy().RefreshMaxMs)).Token;
            await tokens.RevokeSso('sso-1');
            assert.equal((await tokens.Redeem(bySso, F.Realm, F.Client)).Outcome, RefreshOutcome.Invalid);
            assert.equal(await tokens.RevokeToken(byToken, F.Realm, F.OtherClient), false);
            assert.equal(await tokens.RevokeToken(byToken, F.Realm, F.Client), true);
            assert.equal((await tokens.Redeem(byToken, F.Realm, F.Client)).Outcome, RefreshOutcome.Invalid);
            now = new Date(now.getTime() + F.HourMs + 1);
            assert.equal((await tokens.Redeem(idle, F.Realm, F.Client)).Outcome, RefreshOutcome.Invalid);
            await tokens.RevokeAccount(F.Realm, F.Account);
            assert.equal((await tokens.Redeem(byAccount, F.Realm, F.Client)).Outcome, RefreshOutcome.Invalid);
        });
    });
});
