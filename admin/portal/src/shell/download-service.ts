import { ServiceBase, ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'

// Saves text as a file the browser downloads. Injected so tests capture the
// file without touching the DOM.
export type FileSaver = (fileName: string, text: string) => void

// The portal's download seam (Mural has none): the default saver hands the
// text to the browser as a Blob behind a temporary link.
export class DownloadService extends ServiceBase
{
    public static readonly Key = new ServiceKey<DownloadService>('DownloadService')
    private static readonly JsonType = 'application/json'
    private static readonly AnchorTag = 'a'
    // Long enough for every browser to have started the download before the URL is released.
    private static readonly RevokeDelayMs = 60000

    private readonly save: FileSaver

    public constructor(provider: IServiceProvider, saver?: FileSaver)
    {
        super(provider)
        this.save = saver ?? ((fileName, text) => DownloadService.SaveInBrowser(fileName, text))
    }

    public Save(fileName: string, text: string): void
    {
        this.save(fileName, text)
    }

    private static SaveInBrowser(fileName: string, text: string): void
    {
        const url = URL.createObjectURL(new Blob([text], { type: DownloadService.JsonType }))
        const anchor = document.createElement(DownloadService.AnchorTag)
        anchor.href = url
        anchor.download = fileName
        // Attached while clicked: some browsers ignore a click on a detached link.
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        setTimeout(() => URL.revokeObjectURL(url), DownloadService.RevokeDelayMs)
    }
}
