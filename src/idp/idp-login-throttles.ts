import { LoginThrottle, type IThrottleRepository, type ThrottleDecision } from '@pragmatic-tech-ai/pragmatic-app-host';
import { LocalPolicy } from './realm-settings.js';
import type { IdpRealm } from './idp-realm.js';

/** The two buckets of one realm's password sign-in: per (account, address), and a wider cap per account. */
export class RealmLoginThrottle
{
    private static readonly AnyAddress = '';

    public constructor(private readonly perAddress: LoginThrottle, private readonly perAccount: LoginThrottle)
    {
    }

    /** Counts the attempt in both buckets (before the password is checked); refused when either is locked. */
    public async Attempt(email: string, address: string): Promise<ThrottleDecision>
    {
        const byAddress = await this.perAddress.Attempt(email, address);
        if (!byAddress.Allowed)
        {
            return byAddress;
        }
        return await this.perAccount.Attempt(email, RealmLoginThrottle.AnyAddress);
    }

    public async Succeeded(email: string, address: string): Promise<void>
    {
        await this.perAddress.Succeeded(email, address);
        await this.perAccount.Succeeded(email, RealmLoginThrottle.AnyAddress);
    }
}

/**
 * The password sign-in throttles of every realm, over the service's throttle table (so replicas share them): the
 * realm's local policy sets the attempts and the lockout; the account-wide cap is a multiple of it (bounds guessing
 * spread over many addresses). Attempts count at the gate, before the password is checked.
 */
export class IdpLoginThrottles
{
    private static readonly AddressPrefix = 'idp-login/';
    private static readonly AccountPrefix = 'idp-login-account/';

    private readonly throttles = new Map<string, RealmLoginThrottle>();

    public constructor(private readonly repository: IThrottleRepository, private readonly now?: () => number)
    {
    }

    public For(realm: IdpRealm): RealmLoginThrottle
    {
        const existing = this.throttles.get(realm.Id);
        if (existing !== undefined)
        {
            return existing;
        }
        const policy = realm.Settings.Local ?? LocalPolicy.Default;
        const I = IdpLoginThrottles;
        const created = new RealmLoginThrottle(
            new LoginThrottle(this.repository, { Name: I.AddressPrefix + realm.Id, MaxAttempts: policy.MaxAttempts, WindowMs: policy.LockoutMs, LockoutMs: policy.LockoutMs, Now: this.now }),
            new LoginThrottle(this.repository, { Name: I.AccountPrefix + realm.Id, MaxAttempts: policy.MaxAttempts * LocalPolicy.AccountCapFactor, WindowMs: policy.LockoutMs, LockoutMs: policy.LockoutMs, Now: this.now }));
        this.throttles.set(realm.Id, created);
        return created;
    }
}
