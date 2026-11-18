/**
 * The single source of truth for what a dangerous path segment is, shared by BOTH confinement layers so they
 * cannot drift: {@link RemoteStorageHandlers.Resolve} over `storage/*` request paths and `EnvSolutionRoots` over
 * manifest member paths. Windows strips trailing dots and spaces from a path segment at the syscall, so `.. `,
 * `...` and `. ` all normalize there to a dot segment (`.`/`..`) or to nothing; every check here compares the
 * trailing-stripped form, closing the trailing-dot/space confinement bypass in one place.
 */
export class PathConfinement
{
    private static readonly SegmentSplit = /[\\/]+/
    private static readonly ControlOrColonPattern = /[:\u0000-\u001f\u007f]/
    private static readonly TrailingStrip = /[. ]+$/
    private static readonly EmptySegment = ''
    private static readonly CurrentSegment = '.'
    private static readonly ParentSegment = '..'

    /** A single segment with its Windows-normalized trailing dots and spaces removed. */
    public static StripTrailing(segment: string): string
    {
        return segment.replace(PathConfinement.TrailingStrip, PathConfinement.EmptySegment)
    }

    /** Whether a segment is, or (after trailing-strip) disguises, a dot segment: empty, `.`, or `..`. */
    public static IsDotSegment(segment: string): boolean
    {
        const stripped = PathConfinement.StripTrailing(segment)
        return stripped === PathConfinement.EmptySegment || stripped === PathConfinement.CurrentSegment || stripped === PathConfinement.ParentSegment
    }

    /** Whether a segment carries a control character (`\u0000`-`\u001f`, `\u007f`) or a colon (drive / NTFS-stream separator). */
    public static HasUnsafeChar(segment: string): boolean
    {
        return PathConfinement.ControlOrColonPattern.test(segment)
    }

    /**
     * Whether a manifest member path stays inside its solution folder: a relative, non-empty path free of control/colon
     * characters, whose every segment is a real name (none is, or disguises, `.`/`..`/empty). Never climbs out.
     */
    public static IsConfinedPath(path: string): boolean
    {
        if (typeof path !== 'string' || path === PathConfinement.EmptySegment || PathConfinement.ControlOrColonPattern.test(path))
        {
            return false
        }
        const segments = path.split(PathConfinement.SegmentSplit)
        if (segments[0] === PathConfinement.EmptySegment)
        {
            return false
        }
        return segments.every(s => !PathConfinement.IsDotSegment(s))
    }
}
