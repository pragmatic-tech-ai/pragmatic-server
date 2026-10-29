export class VersionOrder
{
    private static readonly Separator = '.'
    private static readonly DigitsOnly = /^[0-9]+$/

    public static Compare(a: string, b: string): -1 | 0 | 1
    {
        const left = String(a).split(VersionOrder.Separator)
        const right = String(b).split(VersionOrder.Separator)
        const length = Math.max(left.length, right.length)
        for (let i = 0; i < length; i++)
        {
            const result = VersionOrder.CompareSegment(left[i], right[i])
            if (result !== 0) return result
        }
        return 0
    }

    private static CompareSegment(x: string | undefined, y: string | undefined): -1 | 0 | 1
    {
        if (x === undefined) return y === undefined ? 0 : -1
        if (y === undefined) return 1
        if (VersionOrder.DigitsOnly.test(x) && VersionOrder.DigitsOnly.test(y))
        {
            const nx = x.replace(/^0+(?=.)/, '')
            const ny = y.replace(/^0+(?=.)/, '')
            if (nx.length !== ny.length) return nx.length < ny.length ? -1 : 1
            return VersionOrder.CompareText(nx, ny)
        }
        return VersionOrder.CompareText(x, y)
    }

    private static CompareText(x: string, y: string): -1 | 0 | 1
    {
        if (x === y) return 0
        return x < y ? -1 : 1
    }
}
