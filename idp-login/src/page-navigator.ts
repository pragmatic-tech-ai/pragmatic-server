// Top-level navigation away from the sign-in page (to the application's
// redirect, an upstream source's broker login, or a federated provider).
// Injected so tests capture where the page went without a DOM.
export interface IPageNavigator
{
    Assign(url: string): void
}

export class BrowserPageNavigator implements IPageNavigator
{
    public Assign(url: string): void
    {
        window.location.assign(url)
    }
}
