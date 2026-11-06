import { randomBytes } from 'node:crypto'
import { EmailDomainPolicy } from './email-domain-policy.js'

/** Where a claimed email domain stands with the platform; the string values travel on the wire and are mirrored by both portals. */
export enum DomainApprovalState
{
    Approved = 'approved',
    Verified = 'verified',
    VerifiedContested = 'verified-contested',
    Revoked = 'revoked',
    Pending = 'pending',
}

/** One domain's verification as the platform answers it: the token to publish, whether its TXT record was last seen, and its state. */
export type DomainVerificationAnswer = { domain: string; token: string; verified: boolean; state: DomainApprovalState; lastCheckedAt?: string }

/** A verification answer plus the exact TXT record (name and value) the tenant has to publish. */
export type DomainVerificationView = DomainVerificationAnswer & { recordName: string; recordValue: string }

/**
 * The DNS TXT record that proves a tenant controls an email domain: `_pragmatic-verification.<domain>` carrying
 * `pragmatic-domain-verification=<token>`. The token is public by design (it is published in DNS), but it is only ever issued by
 * the platform and never accepted from a client.
 */
export class DomainVerificationRecord
{
    public static readonly NamePrefix = '_pragmatic-verification.'
    public static readonly ValuePrefix = 'pragmatic-domain-verification='
    /** 32 random bytes as base64url: 43 characters, no padding. */
    public static readonly TokenPattern = /^[A-Za-z0-9_-]{43}$/
    private static readonly TokenBytes = 32
    private static readonly TokenEncoding = 'base64url'
    private static readonly States: ReadonlySet<string> = new Set(Object.values(DomainApprovalState))

    /** A fresh random token. */
    public static NewToken(): string
    {
        return randomBytes(DomainVerificationRecord.TokenBytes).toString(DomainVerificationRecord.TokenEncoding)
    }

    /** The TXT record name for `domain`, normalised (trimmed, lowercased, one trailing dot dropped) first. */
    public static NameFor(domain: string): string
    {
        return DomainVerificationRecord.NamePrefix + EmailDomainPolicy.Normalise(domain)
    }

    /** The TXT record value that carries `token`. */
    public static ValueFor(token: string): string
    {
        return DomainVerificationRecord.ValuePrefix + token
    }

    /**
     * True when any one record, its character-strings joined and surrounding whitespace trimmed, is exactly our value. Other
     * records at the name (SPF, another tenant's token) are ignored; comparison is case-sensitive.
     */
    public static Matches(records: readonly (readonly string[])[], token: string): boolean
    {
        const expected = DomainVerificationRecord.ValueFor(token)
        return records.some(chunks => chunks.join('').trim() === expected)
    }

    /** The answer plus the record the tenant has to publish. */
    public static ViewOf(answer: DomainVerificationAnswer): DomainVerificationView
    {
        return {
            ...answer,
            recordName: DomainVerificationRecord.NameFor(answer.domain),
            recordValue: DomainVerificationRecord.ValueFor(answer.token),
        }
    }

    /**
     * A well-formed answer copied field by field (unknown fields dropped), or undefined when anything is off: a non-object or array,
     * a domain CheckSyntax refuses, a token outside TokenPattern, a non-boolean verified, an unknown state, or a lastCheckedAt that
     * is present but not a string Date.parse accepts.
     */
    public static ParseAnswer(value: unknown): DomainVerificationAnswer | undefined
    {
        if (typeof value !== 'object' || value === null || Array.isArray(value))
        {
            return undefined
        }
        const { domain, token, verified, state, lastCheckedAt } = value as Record<string, unknown>
        if (typeof domain !== 'string' || EmailDomainPolicy.CheckSyntax(domain) !== undefined)
        {
            return undefined
        }
        if (typeof token !== 'string' || !DomainVerificationRecord.TokenPattern.test(token))
        {
            return undefined
        }
        if (typeof verified !== 'boolean' || typeof state !== 'string' || !DomainVerificationRecord.States.has(state))
        {
            return undefined
        }
        const answer: DomainVerificationAnswer = { domain, token, verified, state: state as DomainApprovalState }
        if (lastCheckedAt === undefined)
        {
            return answer
        }
        if (typeof lastCheckedAt !== 'string' || Number.isNaN(Date.parse(lastCheckedAt)))
        {
            return undefined
        }
        return { ...answer, lastCheckedAt }
    }
}
