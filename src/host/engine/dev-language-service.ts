import type { TodlDocument, WikiOrigin } from '@pragmatic-tech-ai/todl'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'

/** The slice of the language service the dev engine reads and writes through (SolutionLanguageService satisfies it). */
export interface IDevLanguageService
{
    /** `originOf` tags a base node with where it was compiled from (an open sibling member, or a published package). */
    ResolveBasesFor(consumerStorage: IStorage): Promise<{ bases: TodlDocument[]; originOf?: ReadonlyMap<string, WikiOrigin> }>
    DidChange(uri: string, text: string): void
    /** The file is gone from storage: drop its live buffer and re-load the owning member from what storage holds. */
    DidDelete(uri: string): void
    WhenIdle(): Promise<void>
    readonly GraphRevision: number
}
