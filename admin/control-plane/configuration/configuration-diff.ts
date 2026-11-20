/** How one path differs between two configuration documents. */
export enum ConfigurationChangeKind
{
    Added = 'added',
    Removed = 'removed',
    Changed = 'changed',
}

/** One difference: the member's JSON pointer, how it changed, and its values on either side (absent when it was not there). */
export type ConfigurationChange = { path: string; kind: ConfigurationChangeKind; before?: unknown; after?: unknown }

/**
 * The difference between two configuration documents, member by member: objects are walked (their members' JSON
 * pointers, RFC 6901), anything else (a value, an array) is compared whole. Secret settings are secret references, so a
 * diff never shows a secret value. Changes are ordered by path.
 */
export class ConfigurationDiff
{
    private static readonly Separator = '/'
    /** The JSON pointer of the whole document. */
    private static readonly Root = ''
    private static readonly Tilde = /~/g
    private static readonly Slash = /\//g
    private static readonly EscapedTilde = '~0'
    private static readonly EscapedSlash = '~1'

    public static Between(before: unknown, after: unknown): ConfigurationChange[]
    {
        const changes: ConfigurationChange[] = []
        ConfigurationDiff.Walk(ConfigurationDiff.Root, before, after, changes)
        return changes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    }

    private static Walk(path: string, before: unknown, after: unknown, changes: ConfigurationChange[]): void
    {
        if (ConfigurationDiff.IsObject(before) && ConfigurationDiff.IsObject(after))
        {
            for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
            {
                const child = path + ConfigurationDiff.Separator + ConfigurationDiff.Escape(key)
                const inBefore = Object.prototype.hasOwnProperty.call(before, key)
                const inAfter = Object.prototype.hasOwnProperty.call(after, key)
                if (inBefore && inAfter)
                {
                    ConfigurationDiff.Walk(child, before[key], after[key], changes)
                }
                else if (inAfter)
                {
                    changes.push({ path: child, kind: ConfigurationChangeKind.Added, after: after[key] })
                }
                else
                {
                    changes.push({ path: child, kind: ConfigurationChangeKind.Removed, before: before[key] })
                }
            }
            return
        }
        if (JSON.stringify(before) !== JSON.stringify(after))
        {
            changes.push({ path, kind: ConfigurationChangeKind.Changed, before, after })
        }
    }

    private static Escape(key: string): string
    {
        return key.replace(ConfigurationDiff.Tilde, ConfigurationDiff.EscapedTilde).replace(ConfigurationDiff.Slash, ConfigurationDiff.EscapedSlash)
    }

    private static IsObject(value: unknown): value is Record<string, unknown>
    {
        return typeof value === 'object' && value !== null && !Array.isArray(value)
    }
}
