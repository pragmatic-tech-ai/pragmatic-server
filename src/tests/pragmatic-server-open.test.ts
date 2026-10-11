import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PragmaticServer } from '../pragmatic-server.js'

/** Test helpers for the offline acceptance golden: temp dirs and a private copy of the read-only fixture. */
class OpenGolden
{
    private static readonly SolutionPrefix = 'ps-sol-'
    private static readonly PackagesPrefix = 'ps-pkgs-'
    private static readonly FixturesDir = 'fixtures'
    private static readonly SampleSolutionDir = 'sample-solution'
    private static readonly MissingDir = 'does-not-exist-xyz'
    public static readonly WidgetId = 'acme.Widget'
    /** The engine's real error for a folder holding no .pksln manifest. */
    public static readonly MissingManifestError = /No \.pksln solution manifest in /

    public static readonly ActiveMessage = 'a solution is active after OpenSolution'
    public static readonly MemberStorageMessage = 'the opened member exposes its storage'
    public static readonly ViewMessage = 'the shared solution graph resolves the member'
    public static readonly WidgetMessage = 'the fixture concept is in the shared model'

    /** Copies the read-only fixture into a temp dir so a test never mutates the checked-in fixture. */
    public static OpenableSolutionDir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), OpenGolden.SolutionPrefix))
        cpSync(join(import.meta.dirname, OpenGolden.FixturesDir, OpenGolden.SampleSolutionDir), dir, { recursive: true })
        return dir
    }

    public static PackagesDir(): string
    {
        return mkdtempSync(join(tmpdir(), OpenGolden.PackagesPrefix))
    }

    public static MissingSolutionDir(): string
    {
        return join(tmpdir(), OpenGolden.MissingDir)
    }

    public static Cleanup(dir: string): void
    {
        rmSync(dir, { recursive: true, force: true })
    }
}

test('opens a real on-disk solution and exposes it through the manager', async () =>
{
    const packages = OpenGolden.PackagesDir()
    const solution = OpenGolden.OpenableSolutionDir()
    const server = new PragmaticServer({ packagesRoot: packages })
    await server.Start()
    try
    {
        await server.OpenSolution(solution)
        const manager = await server.Manager()
        assert.ok(manager.ActiveSolution, OpenGolden.ActiveMessage)
        assert.equal(manager.ActiveSolution.Members.ToArray().length, 1)
    }
    finally
    {
        await server.Dispose()
        OpenGolden.Cleanup(solution)
        OpenGolden.Cleanup(packages)
    }
})

test('drives a domain query through the language service in-process', async () =>
{
    const packages = OpenGolden.PackagesDir()
    const solution = OpenGolden.OpenableSolutionDir()
    const server = new PragmaticServer({ packagesRoot: packages })
    await server.Start()
    try
    {
        await server.OpenSolution(solution)
        const manager = await server.Manager()
        const storage = manager.ActiveSolution?.Members.ToArray()[0]?.Storage
        assert.ok(storage, OpenGolden.MemberStorageMessage)
        const ls = await server.LanguageService()
        const view = await ls.ModelView(storage)
        assert.ok(view, OpenGolden.ViewMessage)
        assert.ok(view.model.has(OpenGolden.WidgetId), OpenGolden.WidgetMessage)
    }
    finally
    {
        await server.Dispose()
        OpenGolden.Cleanup(solution)
        OpenGolden.Cleanup(packages)
    }
})

test('OpenSolution on a non-existent location rejects with a clear error', async () =>
{
    const packages = OpenGolden.PackagesDir()
    const server = new PragmaticServer({ packagesRoot: packages })
    await server.Start()
    try
    {
        await assert.rejects(server.OpenSolution(OpenGolden.MissingSolutionDir()), OpenGolden.MissingManifestError)
    }
    finally
    {
        await server.Dispose()
        OpenGolden.Cleanup(packages)
    }
})
