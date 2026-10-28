import type { SecurityModelViewModel } from './security-model-view-model.js'
import type { BusinessUnitDto } from './tenant-types.js'

// One business unit row. Holds a LIVE reference to the draft's DTO and is rebuilt fresh on every
// Refresh(), so reads stay current; edits go through the view-model.
export class BusinessUnitRow
{
    public constructor(
        private readonly unit: BusinessUnitDto,
        private readonly vm: SecurityModelViewModel)
    {
    }

    public get Id(): string
    {
        return this.unit.id
    }

    public get Name(): string
    {
        return this.unit.name
    }

    public get Parent(): string | undefined
    {
        return this.unit.parent
    }

    public Rename(name: string): void
    {
        this.vm.RenameBusinessUnit(this.unit.id, name)
    }

    public SetParent(parent: string | undefined): void
    {
        this.vm.SetBusinessUnitParent(this.unit.id, parent)
    }

    public Remove(): void
    {
        this.vm.RemoveBusinessUnit(this.unit.id)
    }
}
