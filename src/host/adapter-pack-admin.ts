/** The pack-administration operations the AdminService drives (hot-invalidate + script-allowlist maintenance). */
export interface IAdapterPackAdmin
{
    Invalidate(name: string): Promise<void>
    AllowScripts(name: string): Promise<void>
    DenyScripts(name: string): Promise<void>
    ListScriptAllowlist(): Promise<readonly string[]>
}
