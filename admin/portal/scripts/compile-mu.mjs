// Compile every .mu under src/ to a sibling .mu.js via the mural CLI.
// Same approach as Plexus's apps/plexus/scripts/compile-mu.mjs: the CLI is
// resolved app-locally (mural's package "exports" do not expose its
// package.json), and compilation is per-file and order-independent, so one
// glob over src/ is enough. The generated .mu.js files are committed.
// The CLI path is realpath'd: mural is a file: dependency (a symlink), and the
// CLI only runs when its own resolved URL equals process.argv[1].
import { execFileSync } from 'node:child_process'
import { existsSync, globSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

class MuCompiler
{
    static CliRelativePath = '@pragmatic-tech-ai/mural/dist/tooling/cli.js'
    static SourceGlob = 'src/**/*.mu'
    static CompileVerb = 'compile'
    static LogPrefix = '[compile-mu]'
    static MissingCli = 'cannot find mural CLI in:'
    static NoSources = 'no .mu files found under src/'

    static Run()
    {
        const cli = MuCompiler.ResolveCli()
        if (cli === undefined)
        {
            process.exit(1)
        }
        const files = globSync(MuCompiler.SourceGlob)
        if (files.length === 0)
        {
            console.warn(MuCompiler.LogPrefix, MuCompiler.NoSources)
            return
        }
        execFileSync(process.execPath, [cli, MuCompiler.CompileVerb, ...files], { stdio: 'inherit' })
    }

    static ResolveCli()
    {
        const candidate = fileURLToPath(new URL(`../node_modules/${MuCompiler.CliRelativePath}`, import.meta.url))
        if (existsSync(candidate))
        {
            return realpathSync(candidate)
        }
        console.error(MuCompiler.LogPrefix, MuCompiler.MissingCli, candidate)
        return undefined
    }
}

MuCompiler.Run()
