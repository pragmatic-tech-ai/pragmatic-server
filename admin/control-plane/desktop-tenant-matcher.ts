import { ConsoleFingerprint } from './console-advert-contract.js'
import { ConsoleAdvertRegistry } from './console-advert-registry.js'
import type { ConsoleAdvertRecord, IConsoleAdvertLookup } from './console-advert-registry.js'
import { ConsoleDomainApprovals } from './console-domain-approvals.js'
import type { DomainStanding } from './console-domain-approvals.js'
import { DomainClaims } from './domain-claims.js'
import { EmailDomainPolicy } from './email-domain-policy.js'
import { HiveConsoleSpecs } from './hive-console-spec.js'
import type { TenantRecord } from './platform-records.js'
import type { TenantAccountIndex } from './tenant-account-index.js'
import type { ITenantDirectory } from './tenant-api/tenant-directory.js'

/** The directory reads discovery needs: the tenant-plane seam plus every tenant (for the domain tier). PlatformDirectory satisfies it. */
export interface IDiscoveryDirectory extends ITenantDirectory
{
    ListTenants(): readonly TenantRecord[]
}

/** Where a hive's account-email fingerprint key comes from (ConsoleFingerprintKeys satisfies it). May throw on an unreadable entry. */
export interface IFingerprintKeySource
{
    Get(hiveId: string): Promise<Buffer | undefined>
}

/** The approved, revoked and verified email domains per tenant (ConsoleDomainApprovals satisfies it). */
export interface IDomainApprovalSource
{
    StandingOf(tenantId: string): DomainStanding
}

export enum DiscoveryMatch
{
    Account = 'account',
    Domain = 'domain'
}

export type DiscoveredTenant = { tenant: TenantRecord; consoleUrl: string; match: DiscoveryMatch }

/** How one tenant is reached: whether it runs an in-hive console, and the advert that counts for it (if any). */
type TenantPlacement = { inHive: boolean; advert: ConsoleAdvertRecord | undefined }

/**
 * Decides which tenants an email belongs to for desktop discovery. Three tiers are unioned, one entry per tenant
 * (an account match wins over a domain match):
 * - an in-hive console's usable advert: its fingerprints (account) and its advertised domains that count (domain), i.e. claimed AND (operator-approved OR verified and
 *   not contested) AND not revoked;
 * - the platform's TenantAccountIndex (account); an in-hive tenant is skipped until its console has advertised;
 * - a control-plane tenant record's emailDomains that count (domain); an in-hive tenant's record domains are ignored.
 * Both domain tiers use ConsoleDomainApprovals.EffectiveDomains: a domain counts when it is claimed AND (operator-approved, OR
 * verified and not contested by another tenant's claim) AND not revoked, so a claim alone never redirects an address. Contention is
 * read afresh on every Match (DomainClaims), so a verified domain enters or leaves discovery as other tenants' claims change.
 * An in-hive tenant points at its advertised console; every other tenant points at the tenant plane. Domains match
 * exactly (no parent-domain matching). Stale adverts are used as they are.
 */
export class DesktopTenantMatcher
{
    private static readonly KeyFailureText = 'Discovery skips account fingerprints: the fingerprint key could not be read for hive '
    private static readonly KeyFailureInfix = ': '
    private static readonly UnknownErrorName = 'Error'

    /** Hives whose unreadable fingerprint key was already logged (once per hive for the life of this matcher). */
    private readonly reportedKeyFailures = new Set<string>()

    public constructor(
        private readonly index: TenantAccountIndex,
        private readonly directory: IDiscoveryDirectory,
        private readonly adverts?: IConsoleAdvertLookup,
        private readonly keys?: IFingerprintKeySource,
        private readonly approvals?: IDomainApprovalSource)
    {
    }

    /** One entry per tenant, Account before Domain, then displayName (localeCompare). */
    public async Match(email: string, tenantPlaneUrl: string): Promise<readonly DiscoveredTenant[]>
    {
        const domain = EmailDomainPolicy.DomainOf(email)
        const found = new Map<string, DiscoveredTenant>()
        const placements = new Map<string, TenantPlacement>()
        const claims = DomainClaims.Collect(this.directory, this.adverts)
        await this.MatchAdverts(email, domain, claims, found, placements)
        this.MatchIndex(email, tenantPlaneUrl, found, placements)
        if (domain !== undefined)
        {
            this.MatchRecordDomains(domain, tenantPlaneUrl, claims, found, placements)
        }
        return [...found.values()].sort(DesktopTenantMatcher.Compare)
    }

    private async MatchAdverts(email: string, domain: string | undefined, claims: DomainClaims, found: Map<string, DiscoveredTenant>, placements: Map<string, TenantPlacement>): Promise<void>
    {
        if (this.adverts === undefined)
        {
            return
        }
        for (const listed of this.adverts.All())
        {
            const tenant = this.directory.GetTenant(listed.tenantId)
            if (tenant === undefined)
            {
                continue
            }
            const advert = this.PlacementOf(tenant.id, placements).advert
            if (advert === undefined)
            {
                continue
            }
            const key = await this.KeyOf(advert.hiveId)
            if (key !== undefined && this.adverts.HasFingerprint(tenant.id, ConsoleFingerprint.Of(key, email)))
            {
                DesktopTenantMatcher.Add(found, { tenant, consoleUrl: advert.consoleUrl, match: DiscoveryMatch.Account })
                continue
            }
            if (domain !== undefined && this.EffectiveDomainsOf(advert.tenantId, advert.emailDomains, claims).includes(domain))
            {
                DesktopTenantMatcher.Add(found, { tenant, consoleUrl: advert.consoleUrl, match: DiscoveryMatch.Domain })
            }
        }
    }

    private MatchIndex(email: string, tenantPlaneUrl: string, found: Map<string, DiscoveredTenant>, placements: Map<string, TenantPlacement>): void
    {
        for (const tenantId of this.index.TenantsFor(email))
        {
            const tenant = this.directory.GetTenant(tenantId)
            if (tenant === undefined)
            {
                continue
            }
            const placement = this.PlacementOf(tenantId, placements)
            if (placement.inHive && placement.advert === undefined)
            {
                continue
            }
            DesktopTenantMatcher.Add(found, { tenant, consoleUrl: placement.advert?.consoleUrl ?? tenantPlaneUrl, match: DiscoveryMatch.Account })
        }
    }

    private MatchRecordDomains(domain: string, tenantPlaneUrl: string, claims: DomainClaims, found: Map<string, DiscoveredTenant>, placements: Map<string, TenantPlacement>): void
    {
        for (const tenant of this.directory.ListTenants())
        {
            if (!this.EffectiveDomainsOf(tenant.id, tenant.emailDomains ?? [], claims).includes(domain))
            {
                continue
            }
            if (this.PlacementOf(tenant.id, placements).inHive)
            {
                continue
            }
            DesktopTenantMatcher.Add(found, { tenant, consoleUrl: tenantPlaneUrl, match: DiscoveryMatch.Domain })
        }
    }

    /** The tenant's placement, read once per Match call. */
    private PlacementOf(tenantId: string, placements: Map<string, TenantPlacement>): TenantPlacement
    {
        const known = placements.get(tenantId)
        if (known !== undefined)
        {
            return known
        }
        const hives = this.directory.ListHives(tenantId)
        const placement: TenantPlacement = {
            inHive: HiveConsoleSpecs.ConsoleHiveOf(hives) !== undefined,
            advert: this.adverts === undefined ? undefined : ConsoleAdvertRegistry.UsableFor(this.adverts, tenantId, hives)
        }
        placements.set(tenantId, placement)
        return placement
    }

    /**
     * The claimed domains (an advert's or a control-plane record's) that count for the tenant under the effective rule; with no
     * approval source no domain counts.
     */
    private EffectiveDomainsOf(tenantId: string, claimed: readonly string[], claims: DomainClaims): readonly string[]
    {
        if (this.approvals === undefined)
        {
            return []
        }
        return ConsoleDomainApprovals.EffectiveDomains(claimed, this.approvals.StandingOf(tenantId), claims.ContestedFor(tenantId))
    }

    /**
     * The hive's fingerprint key; a missing or unreadable key (e.g. a tampered sealed entry) reads as none. An unreadable key
     * is logged once per hive (fixed sentence, hive id and error name only): discovery is unauthenticated, so a per-request
     * log line would let anyone flood the log.
     */
    private async KeyOf(hiveId: string): Promise<Buffer | undefined>
    {
        if (this.keys === undefined)
        {
            return undefined
        }
        try
        {
            return await this.keys.Get(hiveId)
        }
        catch (err)
        {
            this.ReportKeyFailure(hiveId, err)
            return undefined
        }
    }

    private ReportKeyFailure(hiveId: string, err: unknown): void
    {
        if (this.reportedKeyFailures.has(hiveId))
        {
            return
        }
        this.reportedKeyFailures.add(hiveId)
        console.warn(DesktopTenantMatcher.KeyFailureText + hiveId + DesktopTenantMatcher.KeyFailureInfix + (err instanceof Error ? err.name : DesktopTenantMatcher.UnknownErrorName))
    }

    /** Keeps one entry per tenant; an account match replaces a domain match, never the reverse. */
    private static Add(found: Map<string, DiscoveredTenant>, entry: DiscoveredTenant): void
    {
        const existing = found.get(entry.tenant.id)
        if (existing === undefined || (existing.match === DiscoveryMatch.Domain && entry.match === DiscoveryMatch.Account))
        {
            found.set(entry.tenant.id, entry)
        }
    }

    private static Compare(a: DiscoveredTenant, b: DiscoveredTenant): number
    {
        if (a.match !== b.match)
        {
            return a.match === DiscoveryMatch.Account ? -1 : 1
        }
        return a.tenant.displayName.localeCompare(b.tenant.displayName)
    }
}
