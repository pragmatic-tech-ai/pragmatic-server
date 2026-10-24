import { spawn } from 'node:child_process'
import { KubectlError } from './kubectl.js'

/**
 * Loads host docker image refs into the kind-based Docker Desktop Kubernetes node's containerd store, the
 * same way `kind load docker-image` does (`docker save <refs> | docker exec -i <node> ctr -n k8s.io images import -`).
 *
 * Docker Desktop's built-in Kubernetes runs on a kind node (providerID `kind://docker/desktop/desktop-control-plane`)
 * whose containerd image store is SEPARATE from the host docker store. A host `docker tag` is invisible to the node,
 * and because the server Deployment pulls with `imagePullPolicy: IfNotPresent` and the local hive has no registry to
 * pull from, the node keeps serving whatever bits it first cached for a tag -- so a freshly rebuilt `pragmatic-server`
 * never reaches a pod that references a tag the node already holds (it runs the stale cached copy instead). Streaming
 * the saved image into the node's containerd overwrites the tag with the fresh bits, so the pod runs what was built.
 *
 * This is local-smoke infrastructure only: the real product path rewrites through a registry (EffectiveRegistry) and
 * the cluster pulls by digest, so it never depends on the host-vs-node store split this works around.
 */
export class KindImageLoader
{
    // Docker Desktop fixes the kind node container name; the smokes already hard-assume the `docker-desktop` context.
    private static readonly DefaultNode = 'desktop-control-plane'
    private static readonly Docker = 'docker'
    private static readonly SaveVerb = 'save'
    private static readonly ExecVerb = 'exec'
    private static readonly InteractiveFlag = '-i'
    private static readonly Ctr = 'ctr'
    private static readonly NamespaceFlag = '-n'
    private static readonly K8sNamespace = 'k8s.io'
    private static readonly ImagesVerb = 'images'
    private static readonly ImportVerb = 'import'
    private static readonly StdinRef = '-'
    private static readonly ErrorEvent = 'error'
    private static readonly DataEvent = 'data'
    private static readonly CloseEvent = 'close'
    private static readonly SaveFailed = 'docker save failed for '
    private static readonly ImportFailed = 'ctr image import into kind node failed for '
    private static readonly RefJoin = ', '
    private static readonly DetailSep = ' -- '
    private static readonly Empty = ''

    public constructor(private readonly node: string = KindImageLoader.DefaultNode)
    {
    }

    /** Saves the given refs together (so shared layers transfer once) and imports them into the node's containerd. */
    public Load(...refs: readonly string[]): Promise<void>
    {
        const S = KindImageLoader
        return new Promise<void>((resolve, reject) =>
        {
            const save = spawn(S.Docker, [S.SaveVerb, ...refs])
            const importer = spawn(
                S.Docker,
                [S.ExecVerb, S.InteractiveFlag, this.node, S.Ctr, S.NamespaceFlag, S.K8sNamespace, S.ImagesVerb, S.ImportVerb, S.StdinRef])
            const refList = refs.join(S.RefJoin)
            let saveErr = S.Empty
            let importErr = S.Empty
            let saveClosed = false
            let importClosed = false
            let saveOk = false
            let importOk = false
            let settled = false
            const fail = (message: string): void =>
            {
                if (settled)
                {
                    return
                }
                settled = true
                reject(new Error(message))
            }
            const maybeResolve = (): void =>
            {
                if (settled || !saveClosed || !importClosed)
                {
                    return
                }
                if (!saveOk)
                {
                    fail(S.SaveFailed + refList + S.DetailSep + KubectlError.Redact(saveErr))
                    return
                }
                if (!importOk)
                {
                    fail(S.ImportFailed + refList + S.DetailSep + KubectlError.Redact(importErr))
                    return
                }
                settled = true
                resolve()
            }
            save.on(S.ErrorEvent, e => fail(S.SaveFailed + refList + S.DetailSep + (e instanceof Error ? e.message : String(e))))
            importer.on(S.ErrorEvent, e => fail(S.ImportFailed + refList + S.DetailSep + (e instanceof Error ? e.message : String(e))))
            save.stderr.on(S.DataEvent, chunk => { saveErr += chunk })
            importer.stderr.on(S.DataEvent, chunk => { importErr += chunk })
            // EPIPE on the save->import pipe surfaces through the importer's exit code, so swallow the raw stream errors.
            save.stdout.on(S.ErrorEvent, () => undefined)
            importer.stdin.on(S.ErrorEvent, () => undefined)
            save.stdout.pipe(importer.stdin)
            save.on(S.CloseEvent, code => { saveClosed = true; saveOk = code === 0; maybeResolve() })
            importer.on(S.CloseEvent, code => { importClosed = true; importOk = code === 0; maybeResolve() })
        })
    }
}
