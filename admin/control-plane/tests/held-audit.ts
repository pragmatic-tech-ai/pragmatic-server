import { AuditRegistry } from '../audit-record.js'

/** An audit whose file write is held inside WriteText until Release runs; Entered resolves once a write gets there. */
export class HeldAudit extends AuditRegistry
{
    public Written = false
    public readonly Entered: Promise<void>
    private readonly gate: Promise<void>
    private enter: () => void = () => undefined
    private release: () => void = () => undefined

    public constructor(filePath: string)
    {
        super(filePath)
        this.Entered = new Promise<void>(res => { this.enter = res })
        this.gate = new Promise<void>(res => { this.release = res })
    }

    public Release(): void
    {
        this.release()
    }

    protected override async WriteText(text: string): Promise<void>
    {
        this.enter()
        await this.gate
        await super.WriteText(text)
        this.Written = true
    }
}
