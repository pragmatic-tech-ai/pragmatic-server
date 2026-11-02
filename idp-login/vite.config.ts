import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

// The Pragmatic theme registers its woff2s through FontManager.ResolveSourceUrl
// relative to the theme chunk, i.e. from `assets/fonts/` next to the bundle.
// They ship inside the mural package (build/resources/pragmatic/fonts) but
// Vite never copies them, so without this every theme font 404s. Emits them as
// build assets under the exact requested name (no content hash), and fails the
// build when any is missing, so dist can never ship without its theme fonts.
// Ported from Plexus's renderer config (apps/plexus/electron.vite.config.ts).
class ThemeFontCopy
{
    private static readonly PluginName = 'idp-login:theme-font-copy'
    private static readonly ApplyBuild = 'build'
    private static readonly AssetType = 'asset'
    private static readonly PackageName = '@pragmatic-tech-ai/mural'
    private static readonly ManifestFile = 'package.json'
    private static readonly FontsDir = join('build', 'resources', 'pragmatic', 'fonts')
    private static readonly FontExtension = '.woff2'
    private static readonly OutputDir = 'assets/fonts/'
    private static readonly NotFoundSuffix = ' not found on the module search path'
    private static readonly MissingPrefix = 'Pragmatic theme fonts missing in '
    private static readonly MissingSeparator = ': '
    private static readonly NoFontsText = 'no woff2 files found'
    private static readonly ListSeparator = ', '
    private static readonly RequiredFonts: readonly string[] = [
        'InterTight-Regular',
        'InterTight-Medium',
        'InterTight-SemiBold',
        'JetBrainsMono-Regular',
        'JetBrainsMono-Medium',
        'SourceSerif4-Regular',
    ]

    // The Vite plugin: on a build, emits every theme woff2 into assets/fonts/.
    public static Plugin(): Plugin
    {
        return {
            name: ThemeFontCopy.PluginName,
            apply: ThemeFontCopy.ApplyBuild,
            generateBundle()
            {
                const dir = ThemeFontCopy.FontsDirectory()
                for (const file of ThemeFontCopy.Fonts(dir))
                {
                    this.emitFile({
                        type: ThemeFontCopy.AssetType,
                        fileName: ThemeFontCopy.OutputDir + file,
                        source: readFileSync(join(dir, file)),
                    })
                }
            },
        }
    }

    // mural's `exports` map does not expose package.json, so require.resolve
    // of the package cannot be used; ask Node's own module lookup for the
    // node_modules search paths instead and take the first that holds mural,
    // following the file: dependency's symlink.
    private static PackageDirectory(): string
    {
        const lookup = createRequire(fileURLToPath(import.meta.url)).resolve.paths(ThemeFontCopy.PackageName) ?? []
        for (const base of lookup)
        {
            const candidate = join(base, ThemeFontCopy.PackageName)
            if (existsSync(join(candidate, ThemeFontCopy.ManifestFile)))
            {
                return realpathSync(candidate)
            }
        }
        throw new Error(ThemeFontCopy.PackageName + ThemeFontCopy.NotFoundSuffix)
    }

    private static FontsDirectory(): string
    {
        return join(ThemeFontCopy.PackageDirectory(), ThemeFontCopy.FontsDir)
    }

    // The woff2 file names in `dir`; throws when any required font is missing.
    private static Fonts(dir: string): string[]
    {
        const files = existsSync(dir)
            ? readdirSync(dir).filter(f => f.endsWith(ThemeFontCopy.FontExtension))
            : []
        const missing = ThemeFontCopy.RequiredFonts.filter(f => !files.includes(f + ThemeFontCopy.FontExtension))
        if (files.length === 0 || missing.length > 0)
        {
            const detail = files.length === 0 ? ThemeFontCopy.NoFontsText : missing.join(ThemeFontCopy.ListSeparator)
            throw new Error(ThemeFontCopy.MissingPrefix + dir + ThemeFontCopy.MissingSeparator + detail)
        }
        return files
    }
}

// Plain browser build of the IdP sign-in app, served by the IdP under /_login/. Mural is consumed as its built
// sibling dist (file: dependency); the 'development' export condition (which
// points at uncompiled src) is deliberately NOT enabled. dedupe forces one
// physical copy of mural's module-level singletons (ThemeManager, Application).
export default defineConfig({
    // The IdP serves the built assets under /_login/ (realm keys cannot start with '_').
    base: '/_login/',
    resolve:
    {
        conditions: ['import', 'module', 'browser', 'default'],
        dedupe: ['@pragmatic-tech-ai/mural', '@pragmatic-tech-ai/todl-runtime'],
    },
    build:
    {
        outDir: 'dist',
        target: 'es2022',
        rolldownOptions: { output: { keepNames: true } },
    },
    plugins: [ThemeFontCopy.Plugin()],
})
