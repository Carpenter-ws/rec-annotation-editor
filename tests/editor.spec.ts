import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const example = (name: string) =>
  path.resolve(process.cwd(), "public/examples", name);

test("edits a complete REC document without coordinate drift", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Open image")
    .setInputFiles(example("rec-aerial-scene.svg"));
  await page
    .getByLabel("Open labels")
    .setInputFiles(example("rec-aerial-scene.txt"));

  const cards = page.locator("[data-annotation-id]");
  await expect(cards).toHaveCount(24);
  await expect(page.getByText("1920 × 1080", { exact: true })).toBeVisible();

  // Selecting directly on the canvas must work and reveal the resize handles.
  await page.getByTestId("bbox-ann_009").click();
  await expect(page.getByTestId("bbox-ann_009")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(page.getByTestId("handle-se")).toBeVisible();

  // Select the second duplicate `person` and confirm its own ID is highlighted.
  const duplicatePeople = page.locator('[data-annotation-label="person"]');
  await duplicatePeople.nth(1).click();
  await expect(page.getByTestId("bbox-ann_002")).toHaveAttribute(
    "data-selected",
    "true",
  );

  const selectedCard = page.locator('[data-annotation-id="ann_002"]');
  const coordinateNames = ["X1", "Y1", "X2", "Y2"];
  const readCoordinates = () =>
    Promise.all(
      coordinateNames.map((name) => selectedCard.getByLabel(name).inputValue()),
    );
  const before = await readCoordinates();
  expect(before).toEqual(["419.84", "137.22", "440.32", "184.32"]);

  // Zoom with the toolbar, then with the cursor-anchored wheel, then pan with
  // Space + drag, then resize the window. View changes never touch the data.
  await page.getByRole("button", { name: "Fit" }).click();
  const initialZoom = await page.getByTestId("zoom-percent").innerText();
  for (let index = 0; index < 4; index += 1) {
    await page.getByRole("button", { name: "Zoom in" }).click();
  }
  await expect(page.getByTestId("zoom-percent")).not.toHaveText(initialZoom);

  // Bring the selected box back into view before Ctrl-wheel zooming on it.
  await duplicatePeople.nth(1).click();
  const canvas = page.locator(".viewport-svg");
  const canvasRect = await canvas.boundingBox();
  if (!canvasRect) throw new Error("annotation canvas is not visible");
  await canvas.hover({
    position: { x: canvasRect.width / 2, y: canvasRect.height / 2 },
  });
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -240);
  await page.keyboard.up("Control");

  await page.keyboard.down("Shift");
  await page.mouse.move(canvasRect.width / 2, canvasRect.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    canvasRect.width / 2 + 60,
    canvasRect.height / 2 + 40,
    { steps: 4 },
  );
  await page.mouse.up();
  await page.keyboard.up("Shift");

  await page.setViewportSize({ width: 1024, height: 768 });
  expect(await readCoordinates()).toEqual(before);

  // Re-locate an isolated box (ann_002 overlaps ann_005 on purpose) and move
  // and resize it with the pointer.
  const targetCard = page.locator('[data-annotation-id="ann_017"]');
  await targetCard.click();
  const targetBefore = await Promise.all(
    coordinateNames.map((name) => targetCard.getByLabel(name).inputValue()),
  );
  expect(targetBefore).toEqual(["720", "342", "742", "390"]);

  const box = page.getByTestId("bbox-ann_017");
  await expect(box).toBeVisible();
  const boxRect = await box.boundingBox();
  if (!boxRect) throw new Error("selected bbox is not visible");
  await page.mouse.move(
    boxRect.x + boxRect.width / 2,
    boxRect.y + boxRect.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    boxRect.x + boxRect.width / 2 + 24,
    boxRect.y + boxRect.height / 2 + 16,
    { steps: 4 },
  );
  await page.mouse.up();
  const afterMove = await Promise.all(
    coordinateNames.map((name) => targetCard.getByLabel(name).inputValue()),
  );
  expect(afterMove).not.toEqual(targetBefore);

  const southeast = page.getByTestId("handle-se");
  const handleRect = await southeast.boundingBox();
  if (!handleRect) throw new Error("resize handle is not visible");
  await page.mouse.move(
    handleRect.x + handleRect.width / 2,
    handleRect.y + handleRect.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    handleRect.x + handleRect.width / 2 + 18,
    handleRect.y + handleRect.height / 2 + 12,
    { steps: 4 },
  );
  await page.mouse.up();
  expect(
    await Promise.all(
      coordinateNames.map((name) => targetCard.getByLabel(name).inputValue()),
    ),
  ).not.toEqual(afterMove);

  const expression = selectedCard.getByLabel("Expression");
  await expression.fill("the person nearest the blue car");
  await expression.blur();

  // Draw a brand-new box and name it with a free-text expression.
  await page.getByRole("button", { name: "Fit" }).click();
  await page.getByRole("button", { name: "Add box" }).click();
  const fitCanvasRect = await canvas.boundingBox();
  if (!fitCanvasRect) throw new Error("annotation canvas is not visible");
  await page.mouse.move(fitCanvasRect.x + 260, fitCanvasRect.y + 220);
  await page.mouse.down();
  await page.mouse.move(
    fitCanvasRect.x + 380,
    fitCanvasRect.y + 330,
    { steps: 4 },
  );
  await page.mouse.up();
  const dialog = page.getByRole("dialog", { name: "New annotation" });
  await dialog
    .getByLabel("Expression")
    .fill("the vehicle in the newly drawn region");
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect(cards).toHaveCount(25);
  await expect(page.getByTestId("add-toast")).toContainText(
    'Added "the vehicle in the newly drawn region"',
  );

  // Delete, Undo, and Redo the new annotation.
  await page
    .locator('[data-annotation-id="ann_025"]')
    .getByRole("button", { name: "Delete annotation" })
    .click();
  await expect(cards).toHaveCount(24);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(cards).toHaveCount(25);
  await page.getByRole("button", { name: "Redo" }).click();
  await expect(cards).toHaveCount(24);

  await page.getByRole("button", { name: "Export" }).click();
  const txtDownloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Export TXT" }).click();
  const txtPath = await (await txtDownloadPromise).path();
  expect(await readFile(txtPath!, "utf8")).toMatch(
    /the person nearest the blue car 0\n/,
  );

  await page.getByRole("button", { name: "Export" }).click();
  const jsonDownloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Export JSON" }).click();
  const jsonPath = await (await jsonDownloadPromise).path();
  const json = JSON.parse(await readFile(jsonPath!, "utf8"));
  expect(json).toMatchObject({
    image: "rec-aerial-scene.svg",
    width: 1920,
    height: 1080,
  });
  expect(json.annotations).toHaveLength(24);
  expect(
    new Set(json.annotations.map((item: { id: string }) => item.id)).size,
  ).toBe(24);
});
