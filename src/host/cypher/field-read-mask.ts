/** Per-request field read authorizer, principal-bound. */
export interface IFieldReadMask
{
    CanRead(concept: string, field: string): boolean
}

/** No identity / no field security: every field is readable. */
export class AllowAllFieldReadMask implements IFieldReadMask
{
    public static readonly Instance = new AllowAllFieldReadMask()

    public CanRead(): boolean
    {
        return true
    }
}
