import { readFileSync } from 'node:fs'
import { MasterKeyError } from './operator-identity.js'

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
