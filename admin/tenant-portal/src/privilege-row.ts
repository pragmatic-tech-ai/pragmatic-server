import type { AccessLevel, PrivilegeAction, SecurityModelDraft } from './security-model-draft.js'

// One concept row of the privilege matrix for the draft's selected role.
export class PrivilegeRow
{
    public constructor(
        private readonly concept: string,
        private readonly draft: SecurityModelDraft)
    {
    }

    public get Concept(): string
    {
        return this.concept
    }

    public LevelFor(action: PrivilegeAction): AccessLevel
    {
        return this.draft.LevelFor(this.concept, action)
    }

    public Cycle(action: PrivilegeAction): AccessLevel
    {
        return this.draft.CycleLevel(this.concept, action)
    }
}
