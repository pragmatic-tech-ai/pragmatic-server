import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

export interface IKeyStore
{
    PublicKey(ref: string): Promise<string>
    PrivateKey(ref: string): Promise<string>
}

/** Names the missing key ref only; never carries key material. */
export class KeyNotFoundError extends Error
{
    private static readonly ErrorName = 'KeyNotFoundError'
    private static readonly MessagePrefix = 'Key not found for ref: '

    public constructor(ref: string)
    {
        super(`${KeyNotFoundError.MessagePrefix}${ref}`)
        this.name = KeyNotFoundError.ErrorName
    }
}

/** Reads PEM key files at `<keysDir>/<ref><suffix>`. */
export class FileKeyStore implements IKeyStore
{
    public static readonly PublicSuffix = '.pub'
    public static readonly PrivateSuffix = '.key'
    private static readonly Encoding = 'utf8'
    private static readonly NotFoundCode = 'ENOENT'

    public constructor(private readonly keysDir: string)
    {
    }

    public PublicKey(ref: string): Promise<string>
    {
        return this.read(ref, FileKeyStore.PublicSuffix)
    }

    public PrivateKey(ref: string): Promise<string>
    {
        return this.read(ref, FileKeyStore.PrivateSuffix)
    }

    private async read(ref: string, suffix: string): Promise<string>
    {
        // A ref is a bare name; anything that could escape keysDir is treated as unknown.
        if (ref.length === 0 || basename(ref) !== ref)
        {
            throw new KeyNotFoundError(ref)
        }
        try
        {
            return await readFile(join(this.keysDir, `${ref}${suffix}`), FileKeyStore.Encoding)
        }
        catch (err)
        {
            if ((err as NodeJS.ErrnoException).code === FileKeyStore.NotFoundCode)
            {
                throw new KeyNotFoundError(ref)
            }
            throw err
        }
    }
}
