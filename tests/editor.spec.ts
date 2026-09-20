import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const example = (name: string) =>
  path.resolve(process.cwd(), "public/examples", name);

test("picks boxes from the original annotations and can edit them", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open files without a dataset" })
    .click();
  await page
    .getByLabel("Open image")
    .setInputFiles(example("rec-aerial-scene.svg"));
  await page
    .getByLabel("Open labels")
    .setInputFiles(example("rec-aerial-scene.txt"));
  await page
    .getByRole("button", { name: /^Toggle .+ boxes$/ })
    .first()
    .waitFor();

  await page
    .getByLabel("Open original annotations")
    .setInputFiles(example("rec-aerial-scene-originals.txt"));
  const originals = page.locator('[data-testid^="ref-ref_"]');
  await expect(originals).toHaveCount(3);

  // Originals are grey dashed, drawn purely as a reference.
  const dashed = await originals.first().evaluate(
    (element) => getComputedStyle(element).strokeDasharray,
  );
  expect(dashed).not.toBe("none");

  // The layer can be put away and brought back from the toolbar.
  await page.getByRole("button", { name: "Hide originals" }).click();
  await expect(originals).toHaveCount(0);
  await page.getByRole("button", { name: "Show originals" }).click();
  await expect(originals).toHaveCount(3);

  // A click outside the add/edit modes goes straight through the layer.
  const idleBox = await originals.first().boundingBox();
  if (!idleBox) throw new Error("original annotation is not visible");
  await page.mouse.click(
    idleBox.x + idleBox.width / 2,
    idleBox.y + idleBox.height / 2,
  );
  await expect(page.getByRole("status")).toContainText("24 annotations");
  await expect(page.getByRole("dialog", { name: "New annotation" })).toHaveCount(
    0,
  );

  // Adding a box is what turns the layer into a source of boxes: the click asks
  // for the expression, prefilled with the one the original carries.
  await page.getByRole("button", { name: "Add box" }).click();
  await originals.first().click();
  const newBox = page.getByRole("dialog", { name: "New annotation" });
  await expect(newBox.getByLabel("Expression")).toHaveValue("boat");
  await newBox.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("status")).toContainText("25 annotations");

  // The copy is an ordinary document box: once nothing is isolated it leaves
  // the canvas again, instead of staying highlighted for good.
  await page.locator(".viewport-svg").click({ position: { x: 6, y: 6 } });
  await expect(page.locator('[data-testid^="bbox-"]')).toHaveCount(0);

  // Isolating its expression draws it again, as a solid document box.
  await page.getByRole("button", { name: "boat", exact: true }).click();
  const accepted = page.locator('[data-testid^="bbox-"]').last();
  await expect(accepted).toBeVisible();
  await expect(accepted).toHaveCSS("stroke-dasharray", "none");
  await expect(accepted).toHaveAttribute("data-testid", "bbox-ann_025");
  // The original it came from is still there, in place.
  await expect(originals).toHaveCount(3);

  // Deleting the document box leaves the layer alone too.
  await page
    .locator('[data-annotation-id="ann_025"]')
    .getByRole("button", { name: "Delete annotation" })
    .click();
  await expect(page.getByRole("status")).toContainText("24 annotations");
  await expect(originals).toHaveCount(3);

  // Originals are read-only until their editing mode is unlocked.
  const first = originals.first();
  const lockedBox = await first.boundingBox();
  if (!lockedBox) throw new Error("original annotation is not visible");
  await page.mouse.move(lockedBox.x + 5, lockedBox.y + 5);
  await page.mouse.down();
  await page.mouse.move(lockedBox.x + 60, lockedBox.y + 50, { steps: 4 });
  await page.mouse.up();
  const afterLockedDrag = await first.boundingBox();
  if (!afterLockedDrag) throw new Error("original annotation is not visible");
  expect(Math.round(afterLockedDrag.x)).toBe(Math.round(lockedBox.x));

  await page.getByRole("button", { name: "Edit originals" }).click();
  await first.click();
  await expect(page.getByLabel("Expression of ref_001")).toHaveValue("boat");
  await page.getByLabel("Expression of ref_001").fill("the moored boat");
  await page.getByLabel("Expression of ref_001").blur();

  const editableBox = await first.boundingBox();
  if (!editableBox) throw new Error("original annotation is not visible");
  await page.mouse.move(editableBox.x + 5, editableBox.y + 5);
  await page.mouse.down();
  await page.mouse.move(editableBox.x + 70, editableBox.y + 60, { steps: 4 });
  await page.mouse.up();
  const afterEditableDrag = await first.boundingBox();
  if (!afterEditableDrag) throw new Error("original annotation is not visible");
  expect(Math.round(afterEditableDrag.x)).not.toBe(Math.round(editableBox.x));

  await page.getByRole("button", { name: "Delete original ref_001" }).click();
  await expect(originals).toHaveCount(2);
  await page.getByRole("button", { name: "Done editing originals" }).click();

  // Leaving the mode takes the originals editor out of the toolbar again.
  await expect(page.getByLabel("Expression of ref_002")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit originals" })).toBeVisible();
  await expect(originals).toHaveCount(2);
});

test("edits a complete REC document without coordinate drift", async ({
  page,
}) => {
  await page.goto("/");
  // The dataset home is the landing page; this flow works on local files.
  await page
    .getByRole("button", { name: "Open files without a dataset" })
    .click();
  await page
    .getByLabel("Open image")
    .setInputFiles(example("rec-aerial-scene.svg"));
  await page
    .getByLabel("Open labels")
    .setInputFiles(example("rec-aerial-scene.txt"));

  // Expressions are listed collapsed at first; reveal the cards underneath.
  await page.getByRole("button", { name: "Expand all" }).click();
  const cards = page.locator("[data-annotation-id]");
  await expect(cards).toHaveCount(24);
  await expect(page.getByText("1920 × 1080", { exact: true })).toBeVisible();

  // The canvas starts clean: boxes only appear for a picked expression.
  await expect(page.getByTestId("bbox-ann_009")).toHaveCount(0);

  // Picking a category draws its boxes; clicking one on the canvas selects it
  // and reveals the resize handles.
  await page
    .getByRole("button", {
      name: "the large building in the upper left",
      exact: true,
    })
    .click();
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

  // Its Edit control retypes the expression of every box in that category.
  await page.getByRole("button", { name: 'Edit "person" expression' }).click();
  const expression = page.getByRole("textbox", { name: "Expression" });
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
  await page.getByRole("menuitem", { name: "Export TXT", exact: true }).click();
  const txtPath = await (await txtDownloadPromise).path();
  expect(await readFile(txtPath!, "utf8")).toMatch(
    /the person nearest the blue car 0\n/,
  );

  await page.getByRole("button", { name: "Export" }).click();
  const jsonDownloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Export JSON", exact: true }).click();
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
