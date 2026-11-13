import type { IExecFile } from '../kubectl.js'

/**
 * Stops a detached process and its children: `taskkill /T /F` on Windows, a SIGTERM to its process group elsewhere (the
 * stack spawns its children detached, so each leads its own group). Callers kill only a process they have just confirmed is
 * still theirs (its port or endpoint answers), so a stale, reused pid is never killed.
 */
export class ProcessTree
{
    private static readonly WindowsPlatform = 'win32'
    private static readonly TaskKill = 'taskkill'
    private static readonly TaskKillArgs = ['/T', '/F', '/PID']
    private static readonly TermSignal = 'SIGTERM'

    public constructor(private readonly exec: IExecFile, private readonly platform: string = process.platform)
    {
    }

    /** Best effort: a process that is already gone is not an error. */
    public async Kill(pid: number): Promise<void>
    {
        const T = ProcessTree
        try
        {
            if (this.platform === T.WindowsPlatform)
            {
                await this.exec.Run(T.TaskKill, [...T.TaskKillArgs, String(pid)])
            }
            else
            {
                process.kill(-pid, T.TermSignal)
            }
        }
        catch
        {
            // already gone
        }
    }
}
