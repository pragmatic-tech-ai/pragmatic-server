import { readFileSync } from 'node:fs'

export type MasterKeyRef = { keyFilePath: string } | { base64Env: string }

/** Resolves the 32-byte AES master key by reference. The key value is never logged or
 *  included in any error message (fail-closed, secret-by-reference). */
export class MasterKeyResolver
{
    private static readonly KeyLength = 32
    private static readonly Base64 = 'base64'
    private static readonly BadLengthMessage = 'master key must be exactly 32 bytes'
    private static readonly MissingEnvMessage = 'master key environment variable is not set'

    public static Resolve(ref: MasterKeyRef): Buffer
    {
        const key = MasterKeyResolver.Load(ref)
        if (key.length !== MasterKeyResolver.KeyLength)
        {
            throw new Error(MasterKeyResolver.BadLengthMessage)
        }
        return key
    }

    private static Load(ref: MasterKeyRef): Buffer
    {
        if ('keyFilePath' in ref)
        {
            return readFileSync(ref.keyFilePath)
        }
        const value = process.env[ref.base64Env]
        if (value === undefined || value.length === 0)
        {
            throw new Error(MasterKeyResolver.MissingEnvMessage)
        }
        return Buffer.from(value, MasterKeyResolver.Base64)
    }
}
