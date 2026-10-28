import { test, expect, type Locator, type Page } from '@playwright/test'
import { ConnectionStatusView } from '../src/connection-status-view.js'
import { EnvironmentsView } from '../src/environments-view.js'
import { NavModel, NavSection } from '../src/nav-model.js'
import { NavRail } from '../src/nav-rail.js'
import { OverviewConnectionCard } from '../src/overview-connection-card.js'
import { OverviewView } from '../src/overview-view.js'
import { ReleasesView } from '../src/releases-view.js'
import { SettingsView } from '../src/settings-view.js'
import { TenantApp } from '../src/tenant-app.js'
import { TopBar } from '../src/top-bar.js'
import { FakeTenantControlPlane } from './fake-tenant-control-plane.js'

// GATED: run via `npm run test:e2e` (playwright test); needs `npm run build`
// (dist/) and Playwright browsers. Not part of the default tsx --test unit run.
//
// Reduced motion: N/A. The kit has no animations and Mural exposes no
// prefers-reduced-motion hook, so there is nothing to assert.
class TenantPortalSteps
{
    // Users & Access has no subtitle; its tab strip is the stable landmark.
    public static readonly UsersAccessLandmark = 'Roles & permissions'
    // Mural draws the keyboard focus ring (Button PART_FocusRing) as a 2px stroke in the Pragmatic BorderFocus colour.
    public static readonly FocusRingSelector = '#app rect[stroke="rgb(34,130,77)"][stroke-width="2"]'
    public static readonly TextSelector = '#app text'
    public static readonly TabKey = 'Tab'
    public static readonly ShiftTabKey = 'Shift+Tab'
    public static readonly EnterKey = 'Enter'
    public static readonly SpaceKey = 'Space'
    public static readonly MaxTabsToAction = 12

    // Section -> landmark text unique to that section's content pane.
    public static readonly Landmarks: ReadonlyMap<NavSection, string> = new Map<NavSection, string>([
        [NavSection.Overview, OverviewView.Sub],
        [NavSection.Environments, EnvironmentsView.Sub],
        [NavSection.UsersAccess, TenantPortalSteps.UsersAccessLandmark],
        [NavSection.Releases, ReleasesView.Sub],
        [NavSection.Settings, SettingsView.Sub],
        [NavSection.ConnectionStatus, ConnectionStatusView.Sub],
    ])

    public static Landmark(section: NavSection): string
    {
        return TenantPortalSteps.Landmarks.get(section) ?? ''
    }

    // Exact-text locator for a Mural text run (Mural paints SVG text, so there are no DOM roles).
    public static Text(page: Page, text: string): Locator
    {
        return page.getByText(text, { exact: true })
    }

    // The nav row for a label: the rail precedes the content pane, so its run is the first match (a pane title can repeat the label).
    public static NavText(page: Page, label: string): Locator
    {
        return TenantPortalSteps.Text(page, label).first()
    }

    // True when exactly one focus ring is painted and it encloses the named text run.
    public static async FocusIsOn(page: Page, label: string): Promise<boolean>
    {
        return page.evaluate(([ringSelector, textSelector, wanted]) =>
        {
            const rings = Array.from(document.querySelectorAll(ringSelector!))
            if (rings.length !== 1)
            {
                return false
            }
            const ring = rings[0]!.getBoundingClientRect()
            return Array.from(document.querySelectorAll(textSelector!)).some(t =>
            {
                if (t.textContent !== wanted)
                {
                    return false
                }
                const r = t.getBoundingClientRect()
                const cx = r.left + r.width / 2
                const cy = r.top + r.height / 2
                return cx >= ring.left && cx <= ring.right && cy >= ring.top && cy <= ring.bottom
            })
        }, [TenantPortalSteps.FocusRingSelector, TenantPortalSteps.TextSelector, label])
    }

    public static async Boot(page: Page, base: string): Promise<void>
    {
        await page.goto(base)
        await expect(TenantPortalSteps.Text(page, OverviewView.Sub)).toBeVisible()
    }

    public static async Press(page: Page, key: string, times: number = 1): Promise<void>
    {
        for (let i = 0; i < times; i++)
        {
            await page.keyboard.press(key)
        }
    }
}

test.describe('tenant portal nav shell', () =>
{
    const fake = new FakeTenantControlPlane()
    let base = ''

    test.beforeAll(async () => { base = await fake.Start() })
    test.afterAll(async () => { await fake.Stop() })

    test('boots to Overview with the six nav sections and the identity plate', async ({ page }) =>
    {
        await TenantPortalSteps.Boot(page, base)
        await expect(TenantPortalSteps.Text(page, NavRail.BrandText)).toBeVisible()
        for (const item of NavModel.Items)
        {
            await expect(TenantPortalSteps.NavText(page, item.Label)).toBeVisible()
        }
        expect(NavModel.Items).toHaveLength(6)
        await expect(TenantPortalSteps.Text(page, FakeTenantControlPlane.TenantDisplayName)).toBeVisible()
        await expect(TenantPortalSteps.Text(page, FakeTenantControlPlane.HiveDisplayName)).toBeVisible()
        await expect(TenantPortalSteps.Text(page, FakeTenantControlPlane.EnvOneName)).toBeVisible()
        await expect(TenantPortalSteps.Text(page, FakeTenantControlPlane.EnvTwoName)).toBeVisible()
    })

    test('each nav section swaps the content pane', async ({ page }) =>
    {
        await TenantPortalSteps.Boot(page, base)
        for (const item of NavModel.Items)
        {
            await TenantPortalSteps.NavText(page, item.Label).click()
            await expect(TenantPortalSteps.Text(page, TenantPortalSteps.Landmark(item.Section))).toBeVisible()
            for (const other of NavModel.Items.filter(o => o.Section !== item.Section))
            {
                await expect(TenantPortalSteps.Text(page, TenantPortalSteps.Landmark(other.Section))).toHaveCount(0)
            }
        }
    })

    test('the Activity drawer opens and closes from the top-bar control', async ({ page }) =>
    {
        await TenantPortalSteps.Boot(page, base)
        const close = TenantPortalSteps.Text(page, TenantApp.ActivityCloseLabel)
        await expect(close).toHaveCount(0)
        await TenantPortalSteps.Text(page, TopBar.ActivityLabel).click()
        await expect(close).toBeVisible()
        await close.click()
        await expect(close).toHaveCount(0)
        await TenantPortalSteps.Text(page, TopBar.ActivityLabel).click()
        await expect(close).toBeVisible()
        await TenantPortalSteps.Text(page, TopBar.ActivityLabel).first().click()
        await expect(close).toHaveCount(0)
    })

    test('Overview renders the recent-activity and connection cards', async ({ page }) =>
    {
        await TenantPortalSteps.Boot(page, base)
        await expect(TenantPortalSteps.Text(page, OverviewView.ActivityTitle)).toBeVisible()
        await expect(TenantPortalSteps.Text(page, OverviewView.SeeAllLabel)).toBeVisible()
        await expect(TenantPortalSteps.Text(page, OverviewConnectionCard.Title)).toBeVisible()
        await expect(TenantPortalSteps.Text(page, OverviewConnectionCard.ViewLabel)).toBeVisible()
    })

    test('a hive with no environments shows the honest Overview empty state', async ({ page }) =>
    {
        fake.EmptyEnvironments = true
        try
        {
            await page.goto(base)
            await expect(TenantPortalSteps.Text(page, OverviewView.EmptyTitle)).toBeVisible()
            await expect(TenantPortalSteps.Text(page, FakeTenantControlPlane.EnvOneName)).toHaveCount(0)
        }
        finally
        {
            fake.EmptyEnvironments = false
        }
    })

    // Keyboard / focus pass. Mural paints SVG (no DOM buttons), so focus is asserted through its drawn focus ring.
    test('keyboard: boot focus is on the active nav item and Tab walks the nav in order', async ({ page }) =>
    {
        await TenantPortalSteps.Boot(page, base)
        await expect.poll(() => TenantPortalSteps.FocusIsOn(page, NavModel.Items[0]!.Label)).toBe(true)
        // The first Tab moves DOM focus onto the Mural host; each later Tab advances Mural focus one stop.
        await TenantPortalSteps.Press(page, TenantPortalSteps.TabKey)
        for (const item of NavModel.Items.slice(1))
        {
            await TenantPortalSteps.Press(page, TenantPortalSteps.TabKey)
            await expect.poll(() => TenantPortalSteps.FocusIsOn(page, item.Label)).toBe(true)
        }
        await TenantPortalSteps.Press(page, TenantPortalSteps.TabKey)
        await expect.poll(() => TenantPortalSteps.FocusIsOn(page, TopBar.ActivityLabel)).toBe(true)
        await TenantPortalSteps.Press(page, TenantPortalSteps.ShiftTabKey)
        await expect.poll(() => TenantPortalSteps.FocusIsOn(page, NavModel.Items[NavModel.Items.length - 1]!.Label)).toBe(true)
    })

    test('keyboard: Enter and Space on a focused nav item navigate', async ({ page }) =>
    {
        await TenantPortalSteps.Boot(page, base)
        await TenantPortalSteps.Press(page, TenantPortalSteps.TabKey, 2)
        await expect.poll(() => TenantPortalSteps.FocusIsOn(page, NavModel.Items[1]!.Label)).toBe(true)
        await TenantPortalSteps.Press(page, TenantPortalSteps.EnterKey)
        await expect(TenantPortalSteps.Text(page, TenantPortalSteps.Landmark(NavSection.Environments))).toBeVisible()
        // Focus stays on the chosen row after the pane swaps; Space on the next row activates it too.
        await expect.poll(() => TenantPortalSteps.FocusIsOn(page, NavModel.Items[1]!.Label)).toBe(true)
        await TenantPortalSteps.Press(page, TenantPortalSteps.TabKey)
        await expect.poll(() => TenantPortalSteps.FocusIsOn(page, NavModel.Items[2]!.Label)).toBe(true)
        await TenantPortalSteps.Press(page, TenantPortalSteps.SpaceKey)
        await expect(TenantPortalSteps.Text(page, TenantPortalSteps.Landmark(NavSection.UsersAccess))).toBeVisible()
    })

    test('keyboard: Enter and Space on the Activity toggle open and close the drawer', async ({ page }) =>
    {
        await TenantPortalSteps.Boot(page, base)
        await TenantPortalSteps.Press(page, TenantPortalSteps.TabKey, NavModel.Items.length + 1)
        await expect.poll(() => TenantPortalSteps.FocusIsOn(page, TopBar.ActivityLabel)).toBe(true)
        const close = TenantPortalSteps.Text(page, TenantApp.ActivityCloseLabel)
        await TenantPortalSteps.Press(page, TenantPortalSteps.EnterKey)
        await expect(close).toBeVisible()
        await TenantPortalSteps.Press(page, TenantPortalSteps.SpaceKey)
        await expect(close).toHaveCount(0)
    })

    test('keyboard: Enter on the Overview Create action opens the create dialog', async ({ page }) =>
    {
        await TenantPortalSteps.Boot(page, base)
        const create = TenantPortalSteps.Text(page, OverviewView.CreateLabel)
        await expect(create).toHaveCount(1)
        await TenantPortalSteps.Press(page, TenantPortalSteps.TabKey)
        // Tab onward past the nav and the top bar until the Create action holds focus.
        let reached = false
        for (let i = 0; i < TenantPortalSteps.MaxTabsToAction && !reached; i++)
        {
            await TenantPortalSteps.Press(page, TenantPortalSteps.TabKey)
            reached = await TenantPortalSteps.FocusIsOn(page, OverviewView.CreateLabel)
        }
        expect(reached).toBe(true)
        await TenantPortalSteps.Press(page, TenantPortalSteps.EnterKey)
        await expect(create.nth(1)).toBeVisible()
    })
})
