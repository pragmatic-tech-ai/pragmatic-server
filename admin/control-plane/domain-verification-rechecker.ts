import type { IDisposable } from '@pragmatic-tech-ai/todl-runtime'
import { IntervalAdvertTimer, type IAdvertTimer } from './console-advert-sender.js'
import type { ConsoleDomainApprovals } from './console-domain-approvals.js'
import { DomainCheck, type DomainTxtVerifier } from './txt-resolver.js'

/** What one pass over the verified domains found. */
export type RecheckSummary = { checked: number; unverified: number; failed: number }

/**
 * Re-checks every verified email domain once a day: a record still published refreshes lastCheckedAt, a record gone or changed
 * unverifies the domain (the token and any approval stay), and a failed lookup changes nothing. It bypasses the per-tenant
 * verify throttle on purpose. The log lines carry counts or an error name only, never a domain, token or tenant.
 */
export class DomainVerificationRechecker
{
    public static readonly IntervalMs = 24 * 60 * 60 * 1000
    private static readonly LogPrefix = '[domain-recheck] '
    private static readonly UnverifiedSuffix = ' domains no longer verified, '
    private static readonly FailedSuffix = ' lookups failed'
    private static readonly UnnamedError = 'Error'

    private ticking: IDisposable | undefined
    private running = false

    public constructor(
        private readonly approvals: ConsoleDomainApprovals,
        private readonly verifier: DomainTxtVerifier,
        private readonly timer: IAdvertTimer = new IntervalAdvertTimer(),
        private readonly log: (line: string) => void = line => console.error(line),
        private readonly now: () => Date = () => new Date())
    {
    }

    /** Runs one pass at once (not awaited, never rejects) and then every IntervalMs. A second Start is a no-op. */
    public Start(): void
    {
        if (this.ticking !== undefined)
        {
            return
        }
        this.ticking = this.timer.Every(DomainVerificationRechecker.IntervalMs, () => this.Launch())
        this.Launch()
    }

    public Stop(): void
    {
        this.ticking?.dispose()
        this.ticking = undefined
    }

    /** Checks the verified entries one at a time. A pass already in flight makes this call a no-op. */
    public async RunOnce(): Promise<RecheckSummary>
    {
        const summary: RecheckSummary = { checked: 0, unverified: 0, failed: 0 }
        if (this.running)
        {
            return summary
        }
        this.running = true
        try
        {
            for (const entry of this.approvals.VerifiedEntries())
            {
                summary.checked++
                try
                {
                    const result = await this.verifier.Check(entry.domain, entry.token)
                    if (result === DomainCheck.Failed)
                    {
                        summary.failed++
                        continue
                    }
                    const verified = result === DomainCheck.Verified
                    await this.approvals.RecordCheck(entry.tenantId, entry.domain, verified, this.now().toISOString())
                    if (!verified)
                    {
                        summary.unverified++
                    }
                }
                catch (error)
                {
                    summary.failed++
                    this.LogErrorName(error)
                }
            }
            if (summary.unverified > 0 || summary.failed > 0)
            {
                this.Emit(DomainVerificationRechecker.LogPrefix + String(summary.unverified) + DomainVerificationRechecker.UnverifiedSuffix
                    + String(summary.failed) + DomainVerificationRechecker.FailedSuffix)
            }
            return summary
        }
        finally
        {
            this.running = false
        }
    }

    private Launch(): void
    {
        this.RunOnce().catch(error => this.LogErrorName(error))
    }

    private LogErrorName(error: unknown): void
    {
        this.Emit(DomainVerificationRechecker.LogPrefix + (error instanceof Error ? error.name : DomainVerificationRechecker.UnnamedError))
    }

    /** A throwing log sink must not turn a background pass into a rejection. */
    private Emit(line: string): void
    {
        try
        {
            this.log(line)
        }
        catch
        {
            return
        }
    }
}
