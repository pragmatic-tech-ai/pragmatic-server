import { OperatorRole } from './operator-identity.js'

/** Route-class gate for the operator console. Pure: no host coupling. Deny-by-default for ReadOnly. */
export class OperatorAuthorization
{
    public static readonly LogoutPath = '/api/logout'
    private static readonly SafeMethods: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

    /** A method is mutating unless it is explicitly safe (so PATCH and unknown verbs are denied to ReadOnly). */
    public IsMutating(method: string): boolean
    {
        return !OperatorAuthorization.SafeMethods.has(method.toUpperCase())
    }

    public Authorize(role: OperatorRole, method: string, path: string): boolean
    {
        if (role === OperatorRole.Full)
        {
            return true
        }
        return path === OperatorAuthorization.LogoutPath || !this.IsMutating(method)
    }
}
