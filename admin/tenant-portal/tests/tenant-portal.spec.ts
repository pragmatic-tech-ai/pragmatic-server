import { test, expect, type Locator, type Page } from '@playwright/test'
import { TenantEventType } from '../src/tenant-types.js'
import { FakeTenantControlPlane } from './fake-tenant-control-plane.js'

// GATED: run via `npm run test:e2e` (playwright test); needs `npm run build`
// (dist/) and Playwright browsers. Not part of the default tsx --test unit run.
// Drives the Mural markup app against the fake tenant control plane.

// The app's visible text, as its .mu markup spells it.
class TenantText
{
    public static readonly OverviewSubtitle = 'Everything running in your hive, Example Hive, for the Example Tenant tenant.'
    public static readonly EnvironmentsSubtitle = 'Running workspaces in your hive. Each serves Capability Maps at its own address.'
    public static readonly ReleasesSubtitle = 'Versions Pragmatic has offered to your hive. Adopting is always your choice.'
    public static readonly CreateEnvironment = 'Create environment'
    public static readonly NameHelp = 'Lowercase letters, digits and hyphens.'
    public static readonly Cancel = 'Cancel'
    public static readonly Back = 'Back'
    public static readonly Stop = 'Stop'
    public static readonly HealthTab = 'Health & activity'
    public static readonly RightNow = 'Right now'
    public static readonly RolesTab = 'Roles & permissions'
    public static readonly AccessLevels = 'Access levels'
    public static readonly TokensTab = 'Tokens'
    public static readonly IssueToken = 'Issue token'
    public static readonly PrincipalPlaceholder = 'e.g. ci-bot'
    public static readonly ScopesPlaceholder = 'e.g. read write'
    public static readonly TokenIssued = 'API token issued'
    public static readonly Saved = "I've saved it"
    public static readonly Done = 'Done'
    public static readonly Adopt = 'Adopt...'
    public static readonly ChooseVersion = 'Choose a version'
    public static readonly LogOut = 'Log out'
    public static readonly ActivityOne = 'Activity (1)'
    public static readonly ActivityCreated = 'Environment gamma-env was created'
    public static readonly HiveDomainTab = 'Hive & domain'
    public static readonly HiveName = 'Production Hive'
    public static readonly Connected = 'Pragmatic is reachable from your hive.'
    public static readonly IssuedPrincipal = 'ci-bot'
    public static readonly IssuedScope = 'read'
    public static readonly CreatedEnvironment = 'gamma-env'
    public static readonly Favicon = '/favicon.ico'
    // Each rail section's page title (its H3), in RailEntry order.
    public static readonly SectionTitles: readonly string[] = [
        'Overview', 'Environments', 'Users & Access', 'Releases', 'Settings', 'Connection status',
    ]
    // Text a template shows only when a binding or a label formatter failed.
    public static readonly BrokenBinding = /undefined|\[object Object\]|NaN/
}

// The rail's entries, in the order app.mu lists the section modules.
enum RailEntry
{
    Overview,
    Environments,
    UsersAccess,
    Releases,
    Settings,
    Connection,
}

// Mural renders the whole app as SVG: a TextBox is a surface with a hidden key
// sink (no <input>), so a field is typed into by clicking its placeholder; each
// control's hit rect sits over its text, so clicks are forced through it. The
// rail is icon-only (names are tooltips), so an entry is clicked at its
// position; every click then asserts the entry's page title, so a layout drift
// fails loudly.
class TenantSteps
{
    // The rail's geometry in CSS px at the default viewport (Mural's
    // ActivityBarRail: 48 wide, items 40 apart, the first centred at y=97).
    private static readonly RailCenterX = 24
    private static readonly RailFirstCenterY = 97
    private static readonly RailPitch = 40
    // From a Checkbox's label back to the middle of the box before it.
    private static readonly BoxOffset = 16
    private static readonly NoLabelBox = 'no layout box for label: '

    public static Text(page: Page, text: string): Locator
    {
        return page.getByText(text, { exact: true })
    }

    // The first visible exact match (tooltips and offscreen copies excluded).
    public static Visible(page: Page, text: string): Locator
    {
        return TenantSteps.Text(page, text).filter({ visible: true }).first()
    }

    public static async Click(page: Page, text: string): Promise<void>
    {
        await TenantSteps.Visible(page, text).click({ force: true })
    }

    // Ticks the Checkbox laid out just before a label (the label itself is a
    // separate TextBlock, not part of the box's hit area).
    public static async ClickBoxBefore(page: Page, label: string): Promise<void>
    {
        const box = await TenantSteps.Visible(page, label).boundingBox()
        if (box === null)
        {
            throw new Error(TenantSteps.NoLabelBox + label)
        }
        await page.mouse.click(box.x - TenantSteps.BoxOffset, box.y + box.height / 2)
    }

    public static async TypeInto(page: Page, placeholder: string, text: string): Promise<void>
    {
        await TenantSteps.Text(page, placeholder).last().click({ force: true })
        await page.keyboard.type(text)
    }

    public static async OpenSection(page: Page, entry: RailEntry): Promise<void>
    {
        await page.mouse.click(TenantSteps.RailCenterX, TenantSteps.RailFirstCenterY + TenantSteps.RailPitch * entry)
        await expect(TenantSteps.Visible(page, TenantText.SectionTitles[entry]!)).toBeVisible()
    }

    public static async Boot(page: Page, base: string): Promise<void>
    {
        await page.goto(base)
        await expect(TenantSteps.Text(page, TenantText.OverviewSubtitle)).toBeVisible()
    }

    public static async ExpectNoBrokenText(page: Page): Promise<void>
    {
        await expect(page.getByText(TenantText.BrokenBinding)).toHaveCount(0)
    }
}

test.describe('tenant admin portal', () =>
{
    let fake = new FakeTenantControlPlane()
    let base = ''

    test.beforeEach(async () =>
    {
        fake = new FakeTenantControlPlane()
        base = await fake.Start()
    })
    test.afterEach(async () =>
    {
        expect(fake.NotFound.filter(p => p !== TenantText.Favicon)).toEqual([])
        await fake.Stop()
    })

    test('boots into the Overview with the theme fonts served', async ({ page }) =>
    {
        await TenantSteps.Boot(page, base)
        await expect(TenantSteps.Visible(page, FakeTenantControlPlane.EnvOneName)).toBeVisible()
        await expect(TenantSteps.Visible(page, TenantText.Connected)).toBeVisible()
        await expect.poll(() => fake.FontsServed.length).toBeGreaterThan(0)
        await TenantSteps.ExpectNoBrokenText(page)
    })

    test('every rail entry opens its section', async ({ page }) =>
    {
        await TenantSteps.Boot(page, base)
        for (const entry of [RailEntry.Environments, RailEntry.UsersAccess, RailEntry.Releases, RailEntry.Settings,
            RailEntry.Connection, RailEntry.Overview])
        {
            await TenantSteps.OpenSection(page, entry)
            await TenantSteps.ExpectNoBrokenText(page)
        }
        await TenantSteps.OpenSection(page, RailEntry.Settings)
        await TenantSteps.Click(page, TenantText.HiveDomainTab)
        await expect(TenantSteps.Visible(page, TenantText.HiveName)).toBeVisible()
    })

    test('Environments: a row opens the detail with its tabs, and Back returns to the list', async ({ page }) =>
    {
        await TenantSteps.Boot(page, base)
        await TenantSteps.OpenSection(page, RailEntry.Environments)
        await TenantSteps.Click(page, FakeTenantControlPlane.EnvOneName)
        await expect(TenantSteps.Visible(page, TenantText.Stop)).toBeVisible()
        await TenantSteps.Click(page, TenantText.HealthTab)
        await expect(TenantSteps.Visible(page, TenantText.RightNow)).toBeVisible()
        await TenantSteps.ExpectNoBrokenText(page)
        await TenantSteps.Click(page, TenantText.Back)
        await expect(TenantSteps.Visible(page, TenantText.EnvironmentsSubtitle)).toBeVisible()
        expect(fake.LifecycleCalls).toEqual([])
    })

    test('Environments: Create environment opens the dialog and Cancel closes it', async ({ page }) =>
    {
        await TenantSteps.Boot(page, base)
        await TenantSteps.OpenSection(page, RailEntry.Environments)
        await TenantSteps.Click(page, TenantText.CreateEnvironment)
        await expect(TenantSteps.Visible(page, TenantText.NameHelp)).toBeVisible()
        await TenantSteps.Click(page, TenantText.Cancel)
        await expect(TenantSteps.Text(page, TenantText.NameHelp).filter({ visible: true })).toHaveCount(0)
        expect(fake.CreatedEnvironments).toEqual([])
    })

    test('Users & Access: tabs show the security model and the tokens', async ({ page }) =>
    {
        await TenantSteps.Boot(page, base)
        await TenantSteps.OpenSection(page, RailEntry.UsersAccess)
        await expect(TenantSteps.Visible(page, FakeTenantControlPlane.UserEmail)).toBeVisible()
        await TenantSteps.Click(page, TenantText.RolesTab)
        await expect(TenantSteps.Visible(page, TenantText.AccessLevels)).toBeVisible()
        await TenantSteps.Click(page, TenantText.TokensTab)
        await expect(TenantSteps.Visible(page, 'ref-1')).toBeVisible()
        await TenantSteps.ExpectNoBrokenText(page)
    })

    test('Users & Access: an issued token is shown once and Done needs "I\'ve saved it"', async ({ page }) =>
    {
        await TenantSteps.Boot(page, base)
        await TenantSteps.OpenSection(page, RailEntry.UsersAccess)
        await TenantSteps.Click(page, TenantText.TokensTab)
        await TenantSteps.Click(page, TenantText.IssueToken)
        await TenantSteps.TypeInto(page, TenantText.PrincipalPlaceholder, TenantText.IssuedPrincipal)
        await TenantSteps.TypeInto(page, TenantText.ScopesPlaceholder, TenantText.IssuedScope)
        await TenantSteps.Text(page, TenantText.IssueToken).last().click({ force: true })
        await expect(TenantSteps.Visible(page, TenantText.TokenIssued)).toBeVisible()
        await expect(TenantSteps.Visible(page, FakeTenantControlPlane.IssuedTokenValue)).toBeVisible()
        // Done does nothing until the operator confirms saving the value.
        await TenantSteps.Click(page, TenantText.Done)
        await expect(TenantSteps.Visible(page, TenantText.TokenIssued)).toBeVisible()
        await TenantSteps.ClickBoxBefore(page, TenantText.Saved)
        await TenantSteps.Click(page, TenantText.Done)
        await expect(TenantSteps.Text(page, FakeTenantControlPlane.IssuedTokenValue).filter({ visible: true })).toHaveCount(0)
        await expect(TenantSteps.Visible(page, 'ref-2')).toBeVisible()
    })

    test('Releases: Adopt opens the adopt wizard', async ({ page }) =>
    {
        await TenantSteps.Boot(page, base)
        await TenantSteps.OpenSection(page, RailEntry.Releases)
        await expect(TenantSteps.Visible(page, TenantText.ReleasesSubtitle)).toBeVisible()
        await TenantSteps.Click(page, TenantText.Adopt)
        await expect(TenantSteps.Visible(page, TenantText.ChooseVersion)).toBeVisible()
        await TenantSteps.ExpectNoBrokenText(page)
        await TenantSteps.Click(page, TenantText.Cancel)
        await expect(TenantSteps.Visible(page, TenantText.ReleasesSubtitle)).toBeVisible()
        expect(fake.TargetCalls).toEqual([])
    })

    test('a tenant event is recorded in Activity', async ({ page }) =>
    {
        await TenantSteps.Boot(page, base)
        await expect.poll(() => fake.EventSocketCount()).toBeGreaterThan(0)
        fake.PushEvent({ type: TenantEventType.EnvironmentCreated, environmentName: TenantText.CreatedEnvironment })
        await TenantSteps.Click(page, TenantText.ActivityOne)
        await expect(TenantSteps.Visible(page, TenantText.ActivityCreated)).toBeVisible()
    })

    test('Log out posts to the server and lands on the identity provider', async ({ page }) =>
    {
        await TenantSteps.Boot(page, base)
        await TenantSteps.Click(page, TenantText.LogOut)
        await expect.poll(() => fake.LogoutCalls).toBe(1)
        await expect(page.getByText(FakeTenantControlPlane.IdpPageText)).toBeVisible()
        expect(fake.BeginLoginCalls).toBe(1)
    })
})
