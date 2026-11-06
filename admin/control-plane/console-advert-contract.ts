import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ConsoleFingerprintKeys } from './console-fingerprint-keys.js'
import type { DomainVerificationAnswer } from './domain-verification-record.js'
import { TenantAccountIndex } from './tenant-account-index.js'

/** What an in-hive console tells the control plane about itself: where it is, who may find it, and which email domains it claims. */
export type ConsoleAdvertBody = { consoleUrl: string; fingerprints: string[]; emailDomains: string[] }

/**
 * What the console takes from the control plane's 200 advert answer: the time of the tenant's last operator Owner reset, when
 * there is one (the console then ends the Owner's sessions once per value), and the verification of each accepted email domain
 * (its TXT token, whether the record was last seen, and its state), which the console holds in memory and shows. The answer's
 * `refusedEmailDomains` is not taken.
 */
export type ConsoleAdvertAnswer = { ownerResetAt?: string; domainVerifications?: DomainVerificationAnswer[] }

export class ConsoleAdvertLimits
{
    public static readonly MaxFingerprints = 10000
    public static readonly MaxUrlLength = 2048
    public static readonly FingerprintPattern = /^[0-9a-f]{64}$/
}

/** Account-email fingerprints: keyed so the control plane can match an address without learning the console's account list. */
export class ConsoleFingerprint
{
    private static readonly Algorithm = 'sha256'
    private static readonly HexEncoding = 'hex'

    /** Lowercase hex HMAC-SHA256(key, TenantAccountIndex.Normalise(email)). */
    public static Of(key: Buffer, email: string): string
    {
        return createHmac(ConsoleFingerprint.Algorithm, key).update(TenantAccountIndex.Normalise(email)).digest(ConsoleFingerprint.HexEncoding)
    }

    /** The key file's bytes when it holds exactly ConsoleFingerprintKeys.KeyBytes; otherwise (missing, unreadable, wrong length) undefined. */
    public static ReadKeyFile(path: string): Buffer | undefined
    {
        try
        {
            const bytes = readFileSync(path)
            return bytes.length === ConsoleFingerprintKeys.KeyBytes ? bytes : undefined
        }
        catch
        {
            return undefined
        }
    }
}
