import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { before, describe, it } from 'node:test'
import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { SharedHomeUsers, SplitHome } from '../assignment-rules.js'
import { ReachReport, SplitAssignment } from '../reach-report.js'
import { SourceImports } from '../source-imports.js'

/** The container line: what each image's entry points reach, measured once. */
class Boundaries
{
    public static readonly Root = join(import.meta.dirname, '..', '..', '..')
    public static readonly SharedPrefix = 'pragmatic-shared/'
    public static readonly TsExtension = '.ts'
    public static readonly Untracked = 'untracked'
    /** Homes that are no container: the archived monorepo's own tooling and the cross-container journeys of pragmatic-e2e. */
    public static readonly Unchecked: ReadonlySet<string> = new Set<string>([SplitHome.Archive, SplitHome.E2e])
    public static Assignment: SplitAssignment
    public static Reach: ReadonlyMap<string, ReadonlySet<string>>

    /** The image's own repository, as AssignmentRules names it. */
    public static HomeOf(app: ReleaseApp): string
    {
        return Object.values(SplitHome).find(home => (home as string) === (app as string)) ?? app
    }
}

describe('container boundaries', () =>
{
    before(async () =>
    {
        const report = new ReachReport(Boundaries.Root)
        Boundaries.Assignment = await report.Assignment()
        Boundaries.Reach = await report.ForEach([...new Set([...ReachReport.Entries.values()].flat())])
    })

    it('no image\'s closure reaches another image\'s own files, nor a shared package meant for other images', () =>
    {
        const crossings: string[] = []
        for (const [app, entries] of ReachReport.Entries)
        {
            const own = Boundaries.HomeOf(app)
            for (const file of new Set(entries.flatMap(entry => [...(Boundaries.Reach.get(entry) ?? [])])))
            {
                const home = Boundaries.Assignment.Homes[file]
                const shared = home.startsWith(Boundaries.SharedPrefix)
                if ((home !== own && !shared) || (shared && !SharedHomeUsers.Allows(home, app)))
                {
                    crossings.push(app + ' -> ' + file + ' (' + home + ')')
                }
            }
        }
        assert.deepEqual(crossings, [])
    })

    it('each container\'s files import, type-only imports included, only their own home (and the test support they carry a copy of)', () =>
    {
        const B = Boundaries
        const imports = new SourceImports(B.Root)
        const support = new Set(B.Assignment.SharedSupport)
        const crossings: string[] = []
        for (const [file, home] of Object.entries(B.Assignment.Homes))
        {
            if (!file.endsWith(B.TsExtension) || B.Unchecked.has(home) || home.startsWith(B.SharedPrefix))
            {
                continue
            }
            for (const target of imports.Of(file))
            {
                const targetHome = B.Assignment.Homes[target]
                if (targetHome === home || support.has(target) || (targetHome === undefined && !existsSync(join(B.Root, target))))
                {
                    continue
                }
                crossings.push(file + ' (' + home + ') -> ' + target + ' (' + (targetHome ?? B.Untracked) + ')')
            }
        }
        assert.deepEqual(crossings, [])
    })
})
