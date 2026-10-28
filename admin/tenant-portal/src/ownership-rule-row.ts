import type { SecurityModelViewModel } from './security-model-view-model.js'
import type { OwnershipRuleDto } from './tenant-types.js'

// One per-concept ownership rule row, addressed by its concept.
export class OwnershipRuleRow
{
    private static readonly Unset = ''

    public constructor(
        private readonly rule: OwnershipRuleDto,
        private readonly vm: SecurityModelViewModel)
    {
    }

    public get Concept(): string
    {
        return this.rule.concept
    }

    public get OwningKind(): string
    {
        return this.rule.owningBusinessUnit.kind
    }

    public get OwningValue(): string
    {
        return this.rule.owningBusinessUnit.value
    }

    public get OwnerKind(): string
    {
        return this.rule.owner?.kind ?? OwnershipRuleRow.Unset
    }

    public get OwnerValue(): string
    {
        return this.rule.owner?.value ?? OwnershipRuleRow.Unset
    }

    public SetOwningKind(kind: string): void
    {
        this.vm.SetOwningSourceKind(this.rule.concept, kind)
    }

    public SetOwningValue(value: string): void
    {
        this.vm.SetOwningSourceValue(this.rule.concept, value)
    }

    public SetOwnerKind(kind: string): void
    {
        this.vm.SetOwnerSourceKind(this.rule.concept, kind)
    }

    public SetOwnerValue(value: string): void
    {
        this.vm.SetOwnerSourceValue(this.rule.concept, value)
    }

    public Remove(): void
    {
        this.vm.RemoveOwnershipRule(this.rule.concept)
    }
}
