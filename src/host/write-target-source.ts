import type { IInstanceView } from '@pragmatic-tech-ai/todl'

/** Fetches the existing-row view for an Update/Delete subject, through the policy-filtered read path. Undefined ⇒ absent or not read-visible. */
export interface IWriteTargetSource
{
    Fetch(concept: string, id: string): Promise<IInstanceView | undefined>
}
