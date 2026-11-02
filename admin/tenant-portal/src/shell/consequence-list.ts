// The consequences a confirm dialog lists under its message, as one bulleted
// block ('' when there are none). Shared by the plain and name-to-confirm
// dialogs.
export class ConsequenceList
{
    private static readonly Prefix = '- '
    private static readonly LineBreak = '\n'
    private static readonly NoText = ''

    public static Text(lines: readonly string[] | undefined): string
    {
        if (lines === undefined || lines.length === 0)
        {
            return ConsequenceList.NoText
        }
        return lines.map(l => ConsequenceList.Prefix + l).join(ConsequenceList.LineBreak)
    }
}
