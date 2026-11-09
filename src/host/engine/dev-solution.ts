import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'

/** A dev solution member as the engine host reads it: its storage, absent for a member that did not open. */
export interface IDevSolutionMember
{
    readonly Storage?: IStorage
}

/** The slice of the active dev solution the engine host reads (TODL's `Solution` satisfies it). */
export interface IDevSolution
{
    readonly Name: string
    readonly Members: { ToArray(): readonly IDevSolutionMember[] }
}
