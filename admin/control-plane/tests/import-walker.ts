import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * Walks a TypeScript file's module specifiers through its relative imports, so a test can assert that a file (the release
 * CLI, the release-toolkit tests the release workflow runs without npm install) reaches only node builtins and relative modules.
 */
export class ImportWalker
{
    private static readonly ImportPattern = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]|\bimport\s*\(\s*`([^`]+)`/g
    private static readonly NodePrefix = 'node:'
    private static readonly RelativePrefix = '.'
    private static readonly JsExtension = /\.js$/
    private static readonly TsExtension = '.ts'
    private static readonly Utf8 = 'utf8'

    /** Every module specifier reachable from the file through relative imports. */
    public static Specifiers(entry: string): string[]
    {
        const S = ImportWalker
        const seen = new Set<string>()
        const specifiers: string[] = []
        const queue = [entry]
        while (queue.length > 0)
        {
            const file = queue.pop() as string
            if (seen.has(file))
            {
                continue
            }
            seen.add(file)
            for (const specifier of S.SpecifiersOfText(readFileSync(file, S.Utf8)))
            {
                specifiers.push(specifier)
                if (specifier.startsWith(S.RelativePrefix))
                {
                    queue.push(resolve(dirname(file), specifier.replace(S.JsExtension, S.TsExtension)))
                }
            }
        }
        return specifiers
    }

    /** Every module specifier in a source text: static, dynamic (quoted or template literal), re-exported or required. */
    public static SpecifiersOfText(text: string): string[]
    {
        return [...text.matchAll(ImportWalker.ImportPattern)].map(m => m[1] ?? m[2])
    }

    public static IsBuiltinOrRelative(specifier: string): boolean
    {
        return specifier.startsWith(ImportWalker.NodePrefix) || specifier.startsWith(ImportWalker.RelativePrefix)
    }

    /** The specifiers reachable from the file that are neither node builtins nor relative modules. */
    public static Offenders(entry: string): string[]
    {
        return ImportWalker.Specifiers(entry).filter(s => !ImportWalker.IsBuiltinOrRelative(s))
    }
}
