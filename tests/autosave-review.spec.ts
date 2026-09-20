import { expect, test } from "@playwright/test";

test("autosaves, prompts before pending navigation, preserves suppression across refresh and resets on home", async ({ page }) => {
  const labels = new Map<string, string>();
  const reviews: Record<string, string> = {};
  const writes: string[] = [];
  await page.route("**/api/datasets", route => route.fulfill({ json: [{ name: "flow", items: ["a", "b", "c"].map(stem => ({
    stem, image: `${stem}.svg`, labels: `${stem}.txt`, review: reviews[stem] ?? "pending",
  })) }] }));
  await page.route("**/datasets/flow/images/**", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"/>' }));
  await page.route("**/thumbnails/**", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"/>' }));
  await page.route("**/datasets/flow/labels/**", route => route.fulfill({ body: labels.get(route.request().url().split("/").at(-1)!) ?? "10 20 100 120 person 0" }));
  await page.route("**/api/datasets/flow/labels/**", async route => {
    const file = route.request().url().split("/").at(-1)!;
    labels.set(file, route.request().postData()!); writes.push(file);
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/datasets/flow/review/**", async route => {
    reviews[route.request().url().split("/").at(-1)!] = route.request().postDataJSON().status;
    await route.fulfill({ status: 204 });
  });
  await page.goto("/editor?dataset=flow&image=a");
  await page.getByRole("button", { name: 'Edit "person" expression', exact: true }).click();
  await page.getByRole("textbox", { name: "Expression", exact: true }).fill("autosaved");
  await page.getByRole("textbox", { name: "Expression", exact: true }).press("Enter");
  await expect.poll(() => labels.get("a.txt")).toContain("autosaved");
  await expect(page.getByLabel("Save status", { exact: true })).toHaveText("Saved");
  const top = await page.getByRole("button", { name: "Home", exact: true }).boundingBox();
  const navigation = await page.getByRole("button", { name: "Next image", exact: true }).boundingBox();
  expect(navigation!.y).toBeGreaterThan(top!.y + top!.height);
  await page.getByRole("button", { name: "Next image", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "请选择审核意见" });
  await dialog.getByRole("radio", { name: "待审核", exact: true }).check();
  await dialog.getByRole("checkbox", { name: "本次会话不再提示" }).check();
  await dialog.getByRole("button", { name: "确认并翻页" }).click();
  await expect(page).toHaveURL(/image=b$/);
  await page.reload();
  await page.getByRole("button", { name: "Previous image", exact: true }).click();
  await expect(page).toHaveURL(/image=a$/);
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: "Open dataset flow", exact: true }).click();
  await page.getByRole("button", { name: "Next image", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "请选择审核意见" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: "审核通过", exact: true }).check();
  await dialog.getByRole("button", { name: "确认并翻页" }).click();
  await expect(page).toHaveURL(/image=b$/);
  expect(reviews.a).toBe("approved");
  expect(writes).toContain("a.txt");
  await page.screenshot({ path: "/tmp/rec-autosave-toolbar.png", fullPage: true });
});
