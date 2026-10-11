import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync } from 'node:fs'
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

    /** Copies the read-only fixture into a temp dir so a test never mutates the checked-in fixture. */
    public static OpenableSolutionDir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), OpenGolden.SolutionPrefix))
        cpSync(join(import.meta.dirname, OpenGolden.FixturesDir, OpenGolden.SampleSolutionDir), dir, { recursive: true })
        return dir
    }

    public static MissingSolutionDir(): string
    {
        return join(tmpdir(), OpenGolden.MissingDir)
    }

    public static NewServer(): PragmaticServer
    {
        return new PragmaticServer({ packagesRoot: mkdtempSync(join(tmpdir(), OpenGolden.PackagesPrefix)) })
    }
}

test('opens a real on-disk solution and exposes it through the manager', async () =>
{
    const server = OpenGolden.NewServer()
    await server.Start()
    try
    {
        await server.OpenSolution(OpenGolden.OpenableSolutionDir())
        const manager = await server.Manager()
        assert.ok(manager.ActiveSolution, 'a solution is active after OpenSolution')
        assert.equal(manager.ActiveSolution.Members.ToArray().length, 1)
    }
    finally
    {
        await server.Dispose()
    }
})

test('drives a domain query through the language service in-process', async () =>
{
    const server = OpenGolden.NewServer()
    await server.Start()
    try
    {
        await server.OpenSolution(OpenGolden.OpenableSolutionDir())
        const manager = await server.Manager()
        const storage = manager.ActiveSolution?.Members.ToArray()[0]?.Storage
        assert.ok(storage, 'the opened member exposes its storage')
        const ls = await server.LanguageService()
        const view = await ls.ModelView(storage)
        assert.ok(view, 'the shared solution graph resolves the member')
        assert.ok(view.model.has(OpenGolden.WidgetId), 'the fixture concept is in the shared model')
    }
    finally
    {
        await server.Dispose()
    }
})

test('OpenSolution on a non-existent location rejects with a clear error', async () =>
{
    const server = OpenGolden.NewServer()
    await server.Start()
    try
    {
        await assert.rejects(server.OpenSolution(OpenGolden.MissingSolutionDir()))
    }
    finally
    {
        await server.Dispose()
    }
})
