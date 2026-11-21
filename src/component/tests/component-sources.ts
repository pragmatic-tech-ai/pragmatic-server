import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'

/**
 * Holds a descriptor to the configuration readers of its application: every `PRAGMATIC_*` variable the readers name is the
 * source of a declared setting (or deliberately left out, with the reason in the test), and every declared source is
 * named by a reader, so a setting is neither forgotten nor invented. A setting's source is the description prefix
 * `ComponentDeclarations` writes (`<VARIABLE>: <text>`).
 */
export class ComponentSources
{
    private static readonly VariablePattern = /\b(?:PRAGMATIC|POSTGRES)_[A-Z0-9_]*[A-Z0-9]\b/g
    private static readonly SourceSeparator = ': '
    private static readonly Utf8 = 'utf8'

    /**
     * A reader that lives in a package: its compiled module under the package's dist (published, unlike its sources),
     * found from the package entry (`dist/index.js`); `distPath` is relative to dist, e.g. `config/x.js`.
     */
    public static InPackage(specifier: string, ...distPath: string[]): string
    {
        return join(dirname(fileURLToPath(import.meta.resolve(specifier))), ...distPath)
    }

    /** The environment sources the descriptor declares (settings read from a configuration document carry none). */
    public static Declared(descriptor: ComponentDescriptor): string[]
    {
        return descriptor.Options
            .flatMap(option => option.Settings.map(setting => setting.Description.split(ComponentSources.SourceSeparator)[0]))
            .filter(name => ComponentSources.IsVariable(name))
    }

    private static IsVariable(name: string): boolean
    {
        return [...name.matchAll(ComponentSources.VariablePattern)].some(match => match[0] === name)
    }

    public static ReadBy(files: readonly string[]): string[]
    {
        const names = new Set<string>()
        for (const file of files)
        {
            for (const match of readFileSync(file, ComponentSources.Utf8).matchAll(ComponentSources.VariablePattern))
            {
                names.add(match[0])
            }
        }
        return [...names].sort()
    }

    /** Every declared source is named by a reader (for an application that reads a subset of a shared reader). */
    public static AssertDeclaredRead(descriptor: ComponentDescriptor, files: readonly string[]): void
    {
        const read = ComponentSources.ReadBy(files)
        assert.deepEqual(ComponentSources.Declared(descriptor).filter(name => !read.includes(name)), [], 'declared but not read')
    }

    /**
     * Declared sources and the variables the readers name agree, up to the variables listed as deliberately undeclared;
     * `readThrough` names variables a reader reads through another class's constant (it names no literal).
     */
    public static AssertCovers(descriptor: ComponentDescriptor, files: readonly string[], undeclared: readonly string[] = [], readThrough: readonly string[] = []): void
    {
        const declared = new Set(ComponentSources.Declared(descriptor))
        const read = [...ComponentSources.ReadBy(files), ...readThrough]
        assert.deepEqual(read.filter(name => !declared.has(name) && !undeclared.includes(name)), [], 'read but not declared')
        assert.deepEqual([...declared].filter(name => !read.includes(name)).sort(), [], 'declared but not read')
        assert.deepEqual(undeclared.filter(name => declared.has(name)), [], 'listed as undeclared but declared')
    }
}
