import { test, expect } from '@playwright/test'
import { HiveDetailView } from '../src/hive-detail-view.js'
import { EnvironmentDetailView } from '../src/environment-detail-view.js'
import { TenantEventType } from '../src/tenant-types.js'
import { TenantTreeView } from '../src/tenant-tree-view.js'
import { FakeTenantControlPlane } from './fake-tenant-control-plane.js'

// GATED: run via `npm run test:e2e` (playwright test); needs `npm run build`
// (dist/) and Playwright browsers. Not part of the default tsx --test unit run.
class TenantPortalSteps
{
    public static readonly LogChunk = 'boot sequence complete\n'
    public static readonly LogChunkText = 'boot sequence complete'

    public static EnvTreeLabel(name: string, status: string): string
    {
        return TenantTreeView.StatusDot + TenantTreeView.StatusSeparator + name + TenantTreeView.StatusSeparator + '(' + status + ')'
    }
}

test.describe('tenant portal', () =>
{
    const fake = new FakeTenantControlPlane()
    let base = ''

    test.beforeAll(async () => { base = await fake.Start() })
    test.afterAll(async () => { await fake.Stop() })

    test('tree renders the hives and their environments', async ({ page }) =>
    {
        await page.goto(base)
        await expect(page.getByText(TenantTreeView.RootLabel, { exact: true })).toBeVisible()
        await expect(page.getByText(FakeTenantControlPlane.HiveOneName, { exact: true })).toBeVisible()
        await expect(page.getByText(FakeTenantControlPlane.HiveTwoName, { exact: true })).toBeVisible()
        await expect(page.getByText(TenantPortalSteps.EnvTreeLabel(FakeTenantControlPlane.EnvOneName, FakeTenantControlPlane.RunningStatus), { exact: true })).toBeVisible()
        await expect(page.getByText(TenantPortalSteps.EnvTreeLabel(FakeTenantControlPlane.EnvTwoName, FakeTenantControlPlane.StoppedStatus), { exact: true })).toBeVisible()
    })

    test('setting a hive target on a non-current version posts it after confirming', async ({ page }) =>
    {
        await page.goto(base)
        await page.getByText(FakeTenantControlPlane.HiveOneName, { exact: true }).click()
        await page.getByText(HiveDetailView.SetTargetLabel, { exact: true }).click()
        await expect(page.getByText(HiveDetailView.ConfirmLabel, { exact: true })).toBeVisible()
        await page.getByText(HiveDetailView.ConfirmLabel, { exact: true }).click()
        await expect.poll(() => fake.TargetCalls.length).toBeGreaterThan(0)
        expect(fake.TargetCalls[0]).toEqual({ subject: FakeTenantControlPlane.HiveOneId, version: FakeTenantControlPlane.NewerVersion })
    })

    test('starting an environment posts it and the logs panel shows a streamed chunk', async ({ page }) =>
    {
        await page.goto(base)
        await page.getByText(TenantPortalSteps.EnvTreeLabel(FakeTenantControlPlane.EnvOneName, FakeTenantControlPlane.RunningStatus), { exact: true }).click()
        await expect(page.getByText(EnvironmentDetailView.LogsHeading, { exact: true })).toBeVisible()
        await page.getByText(EnvironmentDetailView.StartLabel, { exact: true }).click()
        await expect.poll(() => fake.LifecycleCalls.length).toBeGreaterThan(0)
        expect(fake.LifecycleCalls[0]).toEqual({ subject: FakeTenantControlPlane.EnvOneName, action: FakeTenantControlPlane.StartAction })

        await expect.poll(() => fake.LogSocketCount(FakeTenantControlPlane.EnvOneName)).toBeGreaterThan(0)
        fake.PushLog(FakeTenantControlPlane.EnvOneName, TenantPortalSteps.LogChunk)
        await expect(page.getByText(TenantPortalSteps.LogChunkText)).toBeVisible()
    })

    test('a pushed environment-changed event re-fetches and the tree shows the new status', async ({ page }) =>
    {
        await page.goto(base)
        await expect(page.getByText(TenantPortalSteps.EnvTreeLabel(FakeTenantControlPlane.EnvOneName, FakeTenantControlPlane.RunningStatus), { exact: true })).toBeVisible()
        await expect.poll(() => fake.EventSocketCount()).toBeGreaterThan(0)
        const before = fake.EnvironmentsRequests
        fake.AlphaStatusOverride = FakeTenantControlPlane.ChangedStatus
        try
        {
            fake.PushEvent({ type: TenantEventType.EnvironmentChanged, environmentName: FakeTenantControlPlane.EnvOneName })
            await expect.poll(() => fake.EnvironmentsRequests).toBeGreaterThan(before)
            await expect(page.getByText(TenantPortalSteps.EnvTreeLabel(FakeTenantControlPlane.EnvOneName, FakeTenantControlPlane.ChangedStatus), { exact: true })).toBeVisible()
        }
        finally
        {
            fake.AlphaStatusOverride = undefined
        }
    })
})
