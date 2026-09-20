import { expect, test } from "@playwright/test";

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="green"/></svg>';

test("home loads only thumbnails; canvas loads a moving image window and supports history", async ({ page }) => {
  const originals: string[] = [];
  await page.route("**/api/datasets", route => route.fulfill({ json: [{
    name: "window-test", items: Array.from({ length: 17 }, (_, i) => ({
      stem: String(i), image: `${i}.svg`, labels: null,
      review: i < 8 ? "approved" : "pending",
    })),
  }] }));
  await page.route("**/thumbnails/**", route => route.fulfill({ contentType: "image/svg+xml", body: svg }));
  await page.route("**/datasets/window-test/images/**", async route => {
    originals.push(new URL(route.request().url()).pathname);
    await new Promise(resolve => setTimeout(resolve, 300));
    await route.fulfill({ contentType: "image/svg+xml", body: svg }).catch(() => {});
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open dataset window-test", exact: true }).waitFor();
  expect(originals).toEqual([]);
  await page.getByRole("button", { name: "Open dataset window-test", exact: true }).click();
  await expect(page).toHaveURL(/\/editor\?dataset=window-test&image=8$/);
  await expect(page.getByText("Loading image: 8…")).toBeVisible();
  await expect(page.locator("svg image")).toHaveAttribute("href", "/datasets/window-test/images/8.svg");
  await expect.poll(() => new Set(originals).size).toBe(15);
  expect([...new Set(originals)].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map(i => `/datasets/window-test/images/${i}.svg`).sort());
  await page.getByRole("button", { name: "Next image", exact: true }).click();
  const review = page.getByRole("dialog", { name: "请选择审核意见" });
  await review.getByRole("radio", { name: "待审核", exact: true }).check();
  await review.getByRole("button", { name: "确认并翻页" }).click();
  await expect(page.locator("svg image")).toHaveAttribute("href", "/datasets/window-test/images/9.svg");
  await expect(page).toHaveURL(/image=9$/);
  await expect.poll(() => originals.some(url => url.endsWith("/16.svg"))).toBe(true);
  expect(originals.some(url => url.endsWith("/0.svg"))).toBe(false);
  await page.goBack();
  await expect(page.getByRole("button", { name: "Open dataset window-test", exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.locator("svg image")).toHaveAttribute("href", "/datasets/window-test/images/9.svg");
  await page.reload();
  await expect(page.locator("svg image")).toHaveAttribute("href", "/datasets/window-test/images/9.svg");
});
