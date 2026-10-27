import type { FieldPermission, SecurityModelDraft } from './security-model-draft.js'

// One secured-field row of the field-security grid for the draft's selected profile.
export class FieldGrantRow
{
    private static readonly LabelSeparator = ' · '

    public constructor(
        private readonly concept: string,
        private readonly field: string,
        private readonly draft: SecurityModelDraft)
    {
    }

    public get Concept(): string
    {
        return this.concept
    }

    public get Field(): string
    {
        return this.field
    }

    public get Label(): string
    {
        return `${this.concept}${FieldGrantRow.LabelSeparator}${this.field}`
    }

    public IsGranted(permission: FieldPermission): boolean
    {
        return this.draft.FieldGrant(this.concept, this.field, permission)
    }

    public Toggle(permission: FieldPermission, value: boolean): void
    {
        this.draft.SetFieldGrant(this.concept, this.field, permission, value)
    }
}
