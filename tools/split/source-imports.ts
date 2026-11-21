import { existsSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import ts from 'typescript'

/**
 * Every relative import of a source file, type-only ones included (the compiler's own pre-processing scan), resolved to a
 * repository path. The reach report follows the runtime bundle, where esbuild drops type-only imports and inlines
 * enum values; a file lifted into a package must also compile there, so the compile-time closure is checked too.
 */
export class SourceImports
{
    private static readonly Relative = '.'
    private static readonly JsExtension = '.js'
    private static readonly TsExtension = '.ts'
    private static readonly IndexFile = '/index.ts'
    private static readonly Utf8 = 'utf8'

    public constructor(private readonly root: string)
    {
    }

    /** The repository paths `file` imports through a relative specifier (types included). */
    public Of(file: string): readonly string[]
    {
        const S = SourceImports
        const text = readFileSync(join(this.root, file), S.Utf8)
        const scan = ts.preProcessFile(text, true, true)
        const targets: string[] = []
        for (const imported of scan.importedFiles)
        {
            if (!imported.fileName.startsWith(S.Relative))
            {
                continue
            }
            targets.push(this.Resolve(posix.normalize(posix.join(posix.dirname(file), imported.fileName))))
        }
        return targets
    }

    private Resolve(target: string): string
    {
        const S = SourceImports
        if (target.endsWith(S.JsExtension))
        {
            return target.slice(0, -S.JsExtension.length) + S.TsExtension
        }
        if (existsSync(join(this.root, target + S.TsExtension)))
        {
            return target + S.TsExtension
        }
        if (existsSync(join(this.root, target + S.IndexFile)))
        {
            return target + S.IndexFile
        }
        return target
    }
}
