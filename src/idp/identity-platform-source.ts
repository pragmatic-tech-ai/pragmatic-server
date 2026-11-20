import { FetchHttpClient } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc';
import type { IHttpClient } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc';
import { IdentityPlatformKeySet, IdentityPlatformPageConfig, IdentityPlatformRejection, IdentityPlatformSettingKeys, IdentityPlatformSettings, IdentityPlatformTokenVerifier } from '@pragmatic-tech-ai/pragmatic-identity-source-identity-platform';
import type { IdentityPlatformToken } from '@pragmatic-tech-ai/pragmatic-identity-source-identity-platform';
import type { IdentityPlatformSourceSettings } from './realm-settings.js';

/** How an Identity Platform token fared. */
export enum IdentityPlatformOutcome
{
    Accepted = 'accepted',
    /** A password account whose email is not verified yet: the page offers to resend the verification email. */
    EmailNotVerified = 'email-not-verified',
    Rejected = 'rejected',
}

/**
 * A realm's Google Identity Platform source (the central realm's accounts). The login page signs the person in with
 * Identity Platform's REST API using the browser key and posts the ID token; this source verifies it with
 * pragmatic-identity-source-identity-platform's verifier (Google's securetoken keys, issuer, audience, freshness,
 * enabled provider, tenant, verified email for password accounts). The account subject is the Identity Platform uid.
 */
export class IdentityPlatformSource
{
    private static readonly ProviderSeparator = ',';

    private readonly verifier: IdentityPlatformTokenVerifier;
    private readonly settings: IdentityPlatformSettings;

    private constructor(private readonly source: IdentityPlatformSourceSettings, http: IHttpClient, now: () => Date)
    {
        this.settings = IdentityPlatformSettings.From(IdentityPlatformSource.SettingsMap(source));
        this.verifier = new IdentityPlatformTokenVerifier(this.settings, new IdentityPlatformKeySet(http, now), now);
    }

    /** `http` serves Google's key set (default fetch; tests hand the fake's). */
    public static For(source: IdentityPlatformSourceSettings, http: IHttpClient = new FetchHttpClient(), now: () => Date = () => new Date()): IdentityPlatformSource
    {
        return new IdentityPlatformSource(source, http, now);
    }

    /** What the login page needs: project, browser key, auth domain, providers, tenant. */
    public PageConfig(): IdentityPlatformPageConfig
    {
        const s = this.settings;
        return new IdentityPlatformPageConfig(s.ProjectId, this.source.ApiKey, s.AuthDomain, s.Providers, s.TenantId);
    }

    public async Verify(idToken: string): Promise<{ Outcome: IdentityPlatformOutcome; Token?: IdentityPlatformToken }>
    {
        const verification = await this.verifier.Verify(idToken);
        if (verification.Token !== null)
        {
            return { Outcome: IdentityPlatformOutcome.Accepted, Token: verification.Token };
        }
        return { Outcome: verification.Rejection === IdentityPlatformRejection.EmailNotVerified ? IdentityPlatformOutcome.EmailNotVerified : IdentityPlatformOutcome.Rejected };
    }

    private static SettingsMap(source: IdentityPlatformSourceSettings): ReadonlyMap<string, string>
    {
        const K = IdentityPlatformSettingKeys;
        const map = new Map<string, string>([
            [K.ProjectId, source.ProjectId],
            // The key itself is resolved already; the settings only need a reference to be present.
            [K.ApiKeyRef, K.ApiKeyRef],
            [K.Providers, source.Providers.join(IdentityPlatformSource.ProviderSeparator)],
            [K.MaxAuthAgeSeconds, String(source.MaxAuthAgeSeconds)],
        ]);
        if (source.TenantId !== undefined)
        {
            map.set(K.TenantId, source.TenantId);
        }
        if (source.AuthDomain !== undefined)
        {
            map.set(K.AuthDomain, source.AuthDomain);
        }
        return map;
    }
}
