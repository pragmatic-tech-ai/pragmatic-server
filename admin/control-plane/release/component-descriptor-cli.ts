import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ComponentImageLabel } from './component-image-label.js'
import { ReleaseComponents } from './release-components.js'
import { ReleaseApp, ReleaseApps } from './release-tag.js'

export type ComponentCliOutput = { Out: (line: string) => void; Err: (line: string) => void }

class ComponentCliUsageError extends Error
{
}

/**
 * Emits the component descriptors the images carry, from the descriptor classes of the applications (so a descriptor
 * cannot drift from the code it describes). Two commands, both run inside the image build (docker/images/Dockerfile):
 *
 * - `emit-all --out <dir>`: every release app's descriptor as `<dir>/<app>/component.json` (the canonical JSON its digest
 *   covers, byte for byte), `<dir>/digests.json` (app to digest) and `<dir>/docker-bake.components.json`, the bake
 *   override that hands each image target its COMPONENT_APP and COMPONENT_DIGEST (the label value).
 * - `emit --app <app> --digest <sha256:...> --out <file>`: one app's descriptor, refused unless its digest is the one given,
 *   so the label an image is built with and the descriptor it carries are the same.
 * - `vendor --out <dir>`: the digest-pinned set the consoles read other containers' descriptors from
 *   (ComponentDescriptorSet): `<dir>/<app>.json` and `<dir>/digests.json`. Its test fails while the vendored set
 *   (`admin/control-plane/descriptors`) differs from the declarations; rerun this to refresh it.
 */
export class ComponentDescriptorCli
{
    private static readonly CommandEmitAll = 'emit-all'
    private static readonly CommandEmit = 'emit'
    private static readonly CommandVendor = 'vendor'
    private static readonly JsonExtension = '.json'
    private static readonly FlagPrefix = '--'
    private static readonly FlagOut = 'out'
    private static readonly FlagApp = 'app'
    private static readonly FlagDigest = 'digest'
    private static readonly CommandFlags: ReadonlyMap<string, readonly string[]> = new Map([
        [ComponentDescriptorCli.CommandEmitAll, [ComponentDescriptorCli.FlagOut]],
        [ComponentDescriptorCli.CommandEmit, [ComponentDescriptorCli.FlagApp, ComponentDescriptorCli.FlagDigest, ComponentDescriptorCli.FlagOut]],
        [ComponentDescriptorCli.CommandVendor, [ComponentDescriptorCli.FlagOut]],
    ])
    /** The descriptor file name in every per-app folder and in the image (`ComponentImageLabel.InImagePath`). */
    public static readonly DescriptorFile = 'component.json'
    public static readonly DigestsFile = 'digests.json'
    public static readonly BakeFile = 'docker-bake.components.json'
    /** The build arguments of docker/images/Dockerfile and docker/postgres/Dockerfile the bake override sets. */
    public static readonly AppArg = 'COMPONENT_APP'
    public static readonly DigestArg = 'COMPONENT_DIGEST'
    private static readonly BakeTargetKey = 'target'
    private static readonly BakeArgsKey = 'args'
    private static readonly JsonIndent = 2
    private static readonly Newline = '\n'
    private static readonly Utf8 = 'utf8'
    private static readonly OkExitCode = 0
    private static readonly FailExitCode = 1
    private static readonly UsageExitCode = 2
    private static readonly UsageMessage = 'Usage: pragmatic-component-descriptors emit-all --out <dir> | emit --app <app> --digest <sha256:...> --out <file> | vendor --out <dir>'
    private static readonly UnknownFlagPrefix = 'Unknown option: --'
    private static readonly DuplicateFlagPrefix = 'Option given more than once: --'
    private static readonly MissingFlagPrefix = 'Missing required option: --'
    private static readonly UnknownAppPrefix = 'Not a release app: '
    private static readonly MismatchPrefix = 'Component descriptor digest mismatch for '
    private static readonly MismatchInfix = ': built '
    private static readonly MismatchExpected = ', expected '
    private static readonly MissingDigestSuffix = ' (no digest given: bake with the docker-bake.components.json override)'
    private static readonly AppDigestSeparator = ' '

    public static Run(argv: readonly string[], output: ComponentCliOutput): number
    {
        const S = ComponentDescriptorCli
        try
        {
            const command = argv[0]
            const allowed = command === undefined ? undefined : S.CommandFlags.get(command)
            if (allowed === undefined)
            {
                throw new ComponentCliUsageError(S.UsageMessage)
            }
            const flags = S.ParseFlags(argv.slice(1), allowed)
            if (command === S.CommandEmitAll)
            {
                S.EmitAll(S.Flag(flags, S.FlagOut), output)
            }
            else if (command === S.CommandVendor)
            {
                S.Vendor(S.Flag(flags, S.FlagOut), output)
            }
            else
            {
                S.EmitOne(S.AppOf(S.Flag(flags, S.FlagApp)), flags.get(S.FlagDigest) ?? '', S.Flag(flags, S.FlagOut), output)
            }
            return S.OkExitCode
        }
        catch (error)
        {
            output.Err(error instanceof Error ? error.message : String(error))
            return error instanceof ComponentCliUsageError ? S.UsageExitCode : S.FailExitCode
        }
    }

    /** The bake override: per image target, the app and the component digest it is labelled with. */
    public static BakeOverride(digests: ReadonlyMap<ReleaseApp, string>): Record<string, unknown>
    {
        const S = ComponentDescriptorCli
        const targets: Record<string, unknown> = {}
        for (const [app, digest] of digests)
        {
            targets[app] = { [S.BakeArgsKey]: { [S.AppArg]: app, [S.DigestArg]: digest } }
        }
        return { [S.BakeTargetKey]: targets }
    }

    private static EmitAll(out: string, output: ComponentCliOutput): void
    {
        const S = ComponentDescriptorCli
        const digests = new Map<ReleaseApp, string>()
        for (const [app, descriptor] of ReleaseComponents.All())
        {
            S.Write(join(out, app, S.DescriptorFile), descriptor.ToCanonicalJson())
            digests.set(app, descriptor.ContentDigest())
            output.Out(app + S.AppDigestSeparator + descriptor.ContentDigest())
        }
        S.Write(join(out, S.DigestsFile), JSON.stringify(Object.fromEntries(digests), null, S.JsonIndent) + S.Newline)
        S.Write(join(out, S.BakeFile), JSON.stringify(S.BakeOverride(digests), null, S.JsonIndent) + S.Newline)
    }

    private static Vendor(out: string, output: ComponentCliOutput): void
    {
        const S = ComponentDescriptorCli
        const digests: Record<string, string> = {}
        for (const [app, descriptor] of ReleaseComponents.All())
        {
            S.Write(join(out, app + S.JsonExtension), descriptor.ToCanonicalJson())
            digests[app] = descriptor.ContentDigest()
            output.Out(app + S.AppDigestSeparator + digests[app])
        }
        S.Write(join(out, S.DigestsFile), JSON.stringify(digests, null, S.JsonIndent) + S.Newline)
    }

    private static EmitOne(app: ReleaseApp, expected: string, out: string, output: ComponentCliOutput): void
    {
        const S = ComponentDescriptorCli
        const descriptor = ReleaseComponents.Of(app)
        const digest = descriptor.ContentDigest()
        if (digest !== expected)
        {
            throw new Error(S.MismatchPrefix + app + S.MismatchInfix + digest + S.MismatchExpected + (expected === '' ? S.MissingDigestSuffix : expected))
        }
        S.Write(out, descriptor.ToCanonicalJson())
        output.Out(app + S.AppDigestSeparator + digest + S.AppDigestSeparator + ComponentImageLabel.InImagePath)
    }

    private static AppOf(name: string): ReleaseApp
    {
        const app = ReleaseApps.All.find(candidate => candidate === name)
        if (app === undefined)
        {
            throw new ComponentCliUsageError(ComponentDescriptorCli.UnknownAppPrefix + name)
        }
        return app
    }

    private static Write(path: string, text: string): void
    {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, text, ComponentDescriptorCli.Utf8)
    }

    private static ParseFlags(args: readonly string[], allowed: readonly string[]): Map<string, string>
    {
        const S = ComponentDescriptorCli
        const flags = new Map<string, string>()
        for (let i = 0; i < args.length; i += 2)
        {
            const arg = args[i]
            const name = arg.startsWith(S.FlagPrefix) ? arg.slice(S.FlagPrefix.length) : undefined
            const value = args[i + 1]
            if (name === undefined || !allowed.includes(name) || value === undefined)
            {
                throw new ComponentCliUsageError(name === undefined || value === undefined ? S.UsageMessage : S.UnknownFlagPrefix + name)
            }
            if (flags.has(name))
            {
                throw new ComponentCliUsageError(S.DuplicateFlagPrefix + name)
            }
            flags.set(name, value)
        }
        return flags
    }

    private static Flag(flags: Map<string, string>, name: string): string
    {
        const value = flags.get(name)
        if (value === undefined || value.length === 0)
        {
            throw new ComponentCliUsageError(ComponentDescriptorCli.MissingFlagPrefix + name)
        }
        return value
    }
}
