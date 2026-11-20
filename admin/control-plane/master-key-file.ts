import { readFileSync } from 'node:fs'

/** The master key file does not hold exactly 32 bytes. */
export class MasterKeyError extends Error
{
    private static readonly ErrorName = 'MasterKeyError'

    public constructor(message: string)
    {
        super(message)
        this.name = MasterKeyError.ErrorName
    }
}

export class MasterKeyFile
{
    private static readonly ExpectedBytes = 32
    private static readonly BadSizeMessage = 'Master key file must contain exactly 32 bytes'

    public static Load(path: string): Buffer
    {
        const key = readFileSync(path)
        if (key.length !== MasterKeyFile.ExpectedBytes)
        {
            throw new MasterKeyError(MasterKeyFile.BadSizeMessage)
        }
        return key
    }
}
