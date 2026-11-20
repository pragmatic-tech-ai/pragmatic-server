/** A `Duration` setting (`<digits><unit>`, unit ms, s, m, h or d) in milliseconds. */
export class IdpDuration
{
    private static readonly Pattern = /^([0-9]+)(ms|s|m|h|d)$/;
    private static readonly UnitMs: ReadonlyMap<string, number> = new Map([
        ['ms', 1],
        ['s', 1000],
        ['m', 60 * 1000],
        ['h', 60 * 60 * 1000],
        ['d', 24 * 60 * 60 * 1000],
    ]);
    private static readonly InvalidMessage = 'not a duration (<digits><unit>, unit ms, s, m, h or d): ';
    private static readonly ZeroMessage = 'a duration must be greater than zero: ';

    /** The milliseconds of a positive duration; throws on a malformed or zero one. */
    public static Millis(text: string): number
    {
        const match = IdpDuration.Pattern.exec(text);
        const unit = match === null ? undefined : IdpDuration.UnitMs.get(match[2]);
        if (match === null || unit === undefined)
        {
            throw new Error(IdpDuration.InvalidMessage + text);
        }
        const millis = Number(match[1]) * unit;
        if (!Number.isSafeInteger(millis) || millis <= 0)
        {
            throw new Error(IdpDuration.ZeroMessage + text);
        }
        return millis;
    }
}
