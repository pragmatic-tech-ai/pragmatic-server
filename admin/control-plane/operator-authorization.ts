import { OperatorRole } from './operator-identity.js'
import { PlaneHttp } from './plane-http.js'

/** Route-class gate for the operator console. Pure: no host coupling. Deny-by-default for ReadOnly. */
export class OperatorAuthorization
{
    /** The single home of the logout path: the host routes on it and the gate exempts it. */
    public static readonly LogoutPath = '/api/logout'
    /** The single home of the own-password-change path: any signed-in operator may change their own password. */
    public static readonly SessionPasswordPath = '/api/session/password'
    /** The gate's copy of the operators path (identical to the host's); the roster read is Full-only even though GET is safe. */
    private static readonly OperatorsPath = '/api/operators'
    /** Safe-method reads that still require the Full role (deny-by-default for ReadOnly). */
    private static readonly FullOnlyReadPaths: ReadonlySet<string> = new Set([OperatorAuthorization.OperatorsPath])
    private static readonly SafeMethods: ReadonlySet<string> = new Set([PlaneHttp.MethodGet, PlaneHttp.MethodHead, PlaneHttp.MethodOptions])

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
        if (OperatorAuthorization.FullOnlyReadPaths.has(path))
        {
            return false
        }
        return path === OperatorAuthorization.LogoutPath || path === OperatorAuthorization.SessionPasswordPath || !this.IsMutating(method)
    }
}
