// A page that holds something live while it is on screen (an environment's
// log stream). Its section calls OnShown when the page becomes the visible
// page of the active section, and OnHidden when it stops being visible: it is
// popped or covered, or the operator switches to another section.
export interface IShownPage
{
    OnShown(): void
    OnHidden(): void
}

// Recognises such pages. They register themselves (Register) in their
// constructor, so recognition is by identity, not by a member-name probe.
export class ShownPage
{
    private static readonly pages = new WeakSet<object>()

    public static Register(page: IShownPage): void
    {
        ShownPage.pages.add(page)
    }

    public static Shown(page: object | undefined): void
    {
        if (ShownPage.IsShownPage(page))
        {
            page.OnShown()
        }
    }

    public static Hidden(page: object | undefined): void
    {
        if (ShownPage.IsShownPage(page))
        {
            page.OnHidden()
        }
    }

    private static IsShownPage(page: object | undefined): page is IShownPage
    {
        return page !== undefined && ShownPage.pages.has(page)
    }
}
