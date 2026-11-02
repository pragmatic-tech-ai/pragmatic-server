// Seam for "drop all shell state and start over": a 401 or a logout reloads the
// page so no service or view-model carries one session into the next.
export interface IPageReloader
{
    Reload(): void
}

export class BrowserPageReloader implements IPageReloader
{
    public Reload(): void
    {
        window.location.reload()
    }
}
