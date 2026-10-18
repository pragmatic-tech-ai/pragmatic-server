import { WriteFailureKind } from '@pragmatic-tech-ai/todl'
import { AppWriteStatus } from '@pragmatic-tech-ai/pragmatic-protocol'

/** Shared wire-status mapping for adapter write failures. */
export class AppWriteStatuses
{
    /** Maps a typed {@link WriteFailureKind} to the wire status, de-conflating a driver error from a version
     *  conflict: a real conflict stays Conflict, a driver Error becomes Failed, an Unsupported batch becomes Invalid. */
    public static Of(kind: WriteFailureKind): AppWriteStatus
    {
        switch (kind)
        {
            case WriteFailureKind.Conflict:
                return AppWriteStatus.Conflict
            case WriteFailureKind.Error:
                return AppWriteStatus.Failed
            case WriteFailureKind.Unsupported:
                return AppWriteStatus.Invalid
        }
    }
}
