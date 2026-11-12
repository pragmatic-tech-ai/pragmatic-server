import { createPublicKey } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export class ReleaseTrustKeyInvalidError extends Error
{
    private static readonly ErrorName = 'ReleaseTrustKeyInvalidError'
    private static readonly MessagePrefix = 'Release trust key is not an Ed25519 public key: '

    public constructor(id: string)
    {
        super(ReleaseTrustKeyInvalidError.MessagePrefix + id)
        this.name = ReleaseTrustKeyInvalidError.ErrorName
    }
}

/** The set of release-signing public keys, loaded from `<id>.pub.pem` files. */
export class ReleaseTrustKeys
{
    private static readonly Suffix = '.pub.pem'
    private static readonly Utf8 = 'utf8'
    private static readonly Ed25519 = 'ed25519'

    private constructor(private readonly keys: ReadonlyMap<string, string>)
    {
    }

    public static FromDirectory(dir: string): ReleaseTrustKeys
    {
        const keys = new Map<string, string>()
        const names = readdirSync(dir).filter(name => name.endsWith(ReleaseTrustKeys.Suffix)).sort()
        for (const name of names)
        {
            const id = name.slice(0, name.length - ReleaseTrustKeys.Suffix.length)
            const pem = readFileSync(join(dir, name), ReleaseTrustKeys.Utf8)
            if (!ReleaseTrustKeys.isEd25519Public(pem))
            {
                throw new ReleaseTrustKeyInvalidError(id)
            }
            keys.set(id, pem)
        }
        return new ReleaseTrustKeys(keys)
    }

    public KeyFor(keyId: string): string | undefined
    {
        return this.keys.get(keyId)
    }

    public get Ids(): readonly string[]
    {
        return [...this.keys.keys()]
    }

    private static isEd25519Public(pem: string): boolean
    {
        try
        {
            const key = createPublicKey(pem)
            return key.type === 'public' && key.asymmetricKeyType === ReleaseTrustKeys.Ed25519
        }
        catch
        {
            return false
        }
    }
}
