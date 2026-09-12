import { devices, expect, test, type Locator, type Page } from "@playwright/test";

import { laneId, mockAuthenticated, projectsForGrid, tag, tasks } from "./fixtures";

const { defaultBrowserType: _ignoredDefaultBrowserType, ...iPhone13 } = devices["iPhone 13"];
const billingBoardPath = "/projects/BILL";
const mobileTouchDragActivationWaitMs = 260;
const mobileTouchDragMoveSteps = 8;
const mobileTouchDragMoveSettleDelayMs = 40;
const mobileTouchDragDropSettleDelayMs = 120;
const mobileTouchDragActivationMoveDistance = 18;
const mobileQuickTapHoldMs = 40;

async function isTaskDragActive(dragOverlay: Locator, taskCard: Locator) {
  if ((await dragOverlay.count()) > 0) {
    return true;
  }

  const taskCardClass = await taskCard.getAttribute("class");
  return taskCardClass?.includes("is-dragging") ?? false;
}

async function beginTaskDrag(page: Page, source: Locator) {
  const taskSurface = source.locator(":scope > .task-card__surface-wrap > .task-card__surface");
  const dragHandle = (await taskSurface.count()) > 0 ? taskSurface : source;
  const dragOverlay = page.locator(".task-card--drag-overlay");
  const taskCard = source
    .locator("xpath=ancestor-or-self::article[contains(concat(' ', normalize-space(@class), ' '), ' task-card ')]")
    .first();

  // CI can occasionally drop the first pointer-down activation path, so retry the
  // whole gesture a few times instead of waiting forever on one dead drag attempt.
  for (const [attemptIndex, pointerMoves] of [
    [
      { x: 18, y: 0, steps: 6 },
      { x: 28, y: -2, steps: 4 },
      { x: 32, y: -4, steps: 2 },
      { x: 44, y: -6, steps: 4 }
    ],
    [
      { x: 20, y: 1, steps: 8 },
      { x: 34, y: -1, steps: 6 },
      { x: 52, y: -5, steps: 5 }
    ],
    [
      { x: 24, y: 2, steps: 10 },
      { x: 42, y: 0, steps: 8 },
      { x: 60, y: -8, steps: 6 }
    ]
  ].entries()) {
    await dragHandle.scrollIntoViewIfNeeded();
    await expect(dragHandle).toBeVisible();
    const sourceBox = await dragHandle.boundingBox();

    expect(sourceBox).not.toBeNull();

    const sourceCenterX = (sourceBox?.x ?? 0) + (sourceBox?.width ?? 0) / 2;
    const sourceCenterY = (sourceBox?.y ?? 0) + (sourceBox?.height ?? 0) / 2;

    await page.mouse.move(sourceCenterX, sourceCenterY, { steps: attemptIndex === 0 ? 6 : 10 });
    if (attemptIndex > 0) {
      await page.waitForTimeout(40);
    }
    await page.mouse.down();
    await page.waitForTimeout(attemptIndex === 0 ? 40 : 80);

    for (const pointerMove of pointerMoves) {
      await page.mouse.move(sourceCenterX + pointerMove.x, sourceCenterY + pointerMove.y, {
        steps: pointerMove.steps
      });

      if (await isTaskDragActive(dragOverlay, taskCard)) {
        return;
      }

      await page.waitForTimeout(40);
      if (await isTaskDragActive(dragOverlay, taskCard)) {
        return;
      }
    }

    for (let settleAttempt = 0; settleAttempt < 4; settleAttempt += 1) {
      await page.waitForTimeout(60);
      if (await isTaskDragActive(dragOverlay, taskCard)) {
        return;
      }
    }

    await page.mouse.up();
    await page.waitForTimeout(120);
  }

  throw new Error("Task drag did not activate after retrying the pointer gesture.");
}

async function hoverDraggedTaskOver(page: Page, target: Locator, targetYRatio = 0.5) {
  async function getTargetBox() {
    await expect(target).toBeAttached();
    await target.scrollIntoViewIfNeeded();
    await expect(target).toBeVisible();
    const targetBox = await target.boundingBox();

    expect(targetBox).not.toBeNull();
    return targetBox;
  }

  await page.waitForTimeout(100);
  const initialTargetBox = await getTargetBox();

  const initialTargetCenterX = (initialTargetBox?.x ?? 0) + (initialTargetBox?.width ?? 0) / 2;
  const viewportWidth =
    page.viewportSize()?.width ??
    Math.ceil((initialTargetBox?.x ?? 0) + (initialTargetBox?.width ?? 0) + 96);
  const horizontalApproachOffset = Math.min(
    84,
    Math.max(((initialTargetBox?.width ?? 0) * 0.65), 48)
  );
  const approachFromRight =
    initialTargetCenterX + horizontalApproachOffset < viewportWidth - 16;
  const initialApproachX = approachFromRight
    ? initialTargetCenterX + horizontalApproachOffset
    : Math.max(initialTargetCenterX - horizontalApproachOffset, 16);

  await page.mouse.move(initialApproachX, Math.max((initialTargetBox?.y ?? 0) - 36, 0), { steps: 18 });
  await page.waitForTimeout(80);

  // Drag previews can shift the list while the pointer is in flight, so re-center on
  // the live target a few times before releasing.
  for (const steps of [20, 12, 8]) {
    const targetBox = await getTargetBox();

    await page.mouse.move(
      (targetBox?.x ?? 0) + (targetBox?.width ?? 0) / 2,
      (targetBox?.y ?? 0) + (targetBox?.height ?? 0) * targetYRatio,
      { steps }
    );
    await page.waitForTimeout(80);
  }

  const finalTargetBox = await getTargetBox();

  await page.mouse.move(
    (finalTargetBox?.x ?? 0) + (finalTargetBox?.width ?? 0) / 2,
    (finalTargetBox?.y ?? 0) + (finalTargetBox?.height ?? 0) * targetYRatio,
    { steps: 4 }
  );
  await page.waitForTimeout(140);
}

async function expectMoveLanePreviewCentered(preview: Locator) {
  const metrics = await preview.evaluate((node) => {
    const label = node.querySelector<HTMLElement>(".task-editor__move-preview-label");
    const value = node.querySelector<HTMLElement>(".task-editor__move-preview-value");

    if (!label || !value) {
      throw new Error("Move lane preview label or value is missing.");
    }

    const previewRect = node.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    const valueRect = value.getBoundingClientRect();
    const centerY = (rect: DOMRect) => rect.top + rect.height / 2;

    return {
      previewCenterY: centerY(previewRect),
      labelCenterY: centerY(labelRect),
      valueCenterY: centerY(valueRect)
    };
  });

  expect(Math.abs(metrics.previewCenterY - metrics.labelCenterY)).toBeLessThanOrEqual(4);
  expect(Math.abs(metrics.previewCenterY - metrics.valueCenterY)).toBeLessThanOrEqual(4);
}

async function hoverDraggedTaskDirectlyToTarget(page: Page, target: Locator, targetYRatio = 0.5) {
  await page.waitForTimeout(100);
  await expect(target).toBeAttached();
  const finalTargetBox = await target.boundingBox();

  expect(finalTargetBox).not.toBeNull();

  await page.mouse.move(
    (finalTargetBox?.x ?? 0) + (finalTargetBox?.width ?? 0) / 2,
    (finalTargetBox?.y ?? 0) + (finalTargetBox?.height ?? 0) * targetYRatio,
    { steps: 16 }
  );
  await page.waitForTimeout(160);
}

async function hoverDraggedTaskToNestTarget(
  page: Page,
  card: Locator,
  targetYRatio = 0.5,
  settleTarget?: Locator
) {
  const nestTarget = taskCardNestTarget(card);
  const hasDedicatedNestTarget = (await nestTarget.count()) > 0;
  const nestTargetClass = hasDedicatedNestTarget ? ((await nestTarget.getAttribute("class")) ?? "") : "";
  const nestTargetYRatio = nestTargetClass.includes("task-card__nest-target--body")
    ? Math.min(targetYRatio, 0.24)
    : targetYRatio;
  const primaryTarget = hasDedicatedNestTarget ? nestTarget : card;

  if (!hasDedicatedNestTarget) {
    const bodyTargetYRatio = Math.max(targetYRatio, 0.62);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await hoverDraggedTaskDirectlyToTarget(page, primaryTarget, bodyTargetYRatio);
      const cardClass = await card.getAttribute("class");
      if (cardClass?.includes("is-nest-target")) {
        return;
      }
    }

    await hoverDraggedTaskDirectlyToTarget(page, primaryTarget, bodyTargetYRatio);
    return;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await hoverDraggedTaskOver(page, primaryTarget, nestTargetYRatio);

    const cardClass = await card.getAttribute("class");
    if (cardClass?.includes("is-nest-target")) {
      if (hasDedicatedNestTarget && settleTarget && (await settleTarget.count()) > 0) {
        await hoverDraggedTaskDirectlyToTarget(page, settleTarget);
      } else {
        await hoverDraggedTaskDirectlyToTarget(page, primaryTarget, nestTargetYRatio);
      }
      return;
    }

    if (hasDedicatedNestTarget && settleTarget && (await settleTarget.count()) > 0) {
      await hoverDraggedTaskDirectlyToTarget(page, settleTarget);
      const settledCardClass = await card.getAttribute("class");
      if (settledCardClass?.includes("is-nest-target")) {
        return;
      }
    }
  }

  await hoverDraggedTaskDirectlyToTarget(page, primaryTarget, nestTargetYRatio);
}

async function dropDraggedTaskOnHeaderTrashZone(page: Page, header: Locator) {
  await expect(header).toBeAttached();
  const headerBox = await header.boundingBox();

  expect(headerBox).not.toBeNull();

  await page.mouse.move(
    (headerBox?.x ?? 0) + (headerBox?.width ?? 0) * 0.28,
    (headerBox?.y ?? 0) + (headerBox?.height ?? 0) * 0.5,
    { steps: 12 }
  );
  await expect(header).toHaveClass(/is-task-trash-active/);
  await finishTaskDrag(page);
}

async function finishTaskDrag(page: Page) {
  const dragOverlay = page.locator(".task-card--drag-overlay");

  await page.mouse.up();
  await expect(dragOverlay).toHaveCount(0);
}

async function dragTaskToTarget(page: Page, source: Locator, target: Locator, targetYRatio = 0.5) {
  await beginTaskDrag(page, source);
  await hoverDraggedTaskOver(page, target, targetYRatio);
  await finishTaskDrag(page);
}

async function getLocatorTouchPoint(target: Locator, targetYRatio = 0.5) {
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeVisible();
  const targetBox = await target.boundingBox();

  expect(targetBox).not.toBeNull();

  return {
    x: Math.round(targetBox!.x + targetBox!.width / 2),
    y: Math.round(targetBox!.y + targetBox!.height * targetYRatio)
  };
}

async function dispatchTouchPoint(
  client: { send(method: string, params?: object): Promise<unknown> },
  type: "touchEnd" | "touchMove" | "touchStart",
  point?: { x: number; y: number }
) {
  await client.send("Input.dispatchTouchEvent", {
    touchPoints: point
      ? [
          {
            force: 1,
            id: 1,
            radiusX: 12,
            radiusY: 12,
            x: point.x,
            y: point.y
          }
        ]
      : [],
    type
  });
}

async function detachTouchClient(client: { detach(): Promise<void> }) {
  try {
    await client.detach();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !/Target page, context or browser has been closed/i.test(error.message)
    ) {
      throw error;
    }
  }
}

async function endTouchGesture(client: { send(method: string, params?: object): Promise<unknown> }) {
  try {
    await dispatchTouchPoint(client, "touchEnd");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !/Target page, context or browser has been closed/i.test(error.message)
    ) {
      throw error;
    }
  }
}

async function tapLocatorWithTouch(page: Page, target: Locator, targetYRatio = 0.5) {
  const client = await page.context().newCDPSession(page);
  const point = await getLocatorTouchPoint(target, targetYRatio);

  try {
    await dispatchTouchPoint(client, "touchStart", point);
    await page.waitForTimeout(mobileQuickTapHoldMs);
    await dispatchTouchPoint(client, "touchEnd");
  } finally {
    await detachTouchClient(client);
  }
}

async function confirmTaskDelete(
  page: Page,
  deleteDialog: Locator,
  projectId: string,
  taskId: string
) {
  const deleteRequest = page.waitForRequest(
    (request) =>
      request.method() === "DELETE" &&
      request.url().endsWith(`/api/v1/projects/${projectId}/tasks/${taskId}`)
  );
  const deleteButton = deleteDialog.getByRole("button", { exact: true, name: "Delete" });

  await deleteButton.click();
  await deleteRequest;
}

function requestMatchesTaskUpdate(
  request: { method(): string; postData(): string | null; url(): string },
  projectId: string,
  taskId: string,
  expectedInput: Partial<{ laneId: string; parentTaskId: string | null; position: number }>
) {
  if (
    request.method() !== "PATCH" ||
    !request.url().endsWith(`/api/v1/projects/${projectId}/tasks/${taskId}`)
  ) {
    return false;
  }

  const postData = request.postData();
  if (!postData) {
    return false;
  }

  try {
    const body = JSON.parse(postData) as {
      laneId?: string;
      parentTaskId?: string | null;
      position?: number;
    };

    return Object.entries(expectedInput).every(([key, value]) => body[key as keyof typeof body] === value);
  } catch {
    return false;
  }
}

async function dragTaskWithTouch(page: Page, source: Locator, target: Locator, targetYRatio = 0.5) {
  const dragOverlay = page.locator(".task-card--drag-overlay");
  const taskCard = source
    .locator("xpath=ancestor-or-self::article[contains(concat(' ', normalize-space(@class), ' '), ' task-card ')]")
    .first();
  const viewport = page.viewportSize();
  const viewportHeight = viewport?.height ?? 844;
  const viewportWidth = viewport?.width ?? 390;

  for (const activationOffset of [
    mobileTouchDragActivationMoveDistance,
    mobileTouchDragActivationMoveDistance + 10,
    mobileTouchDragActivationMoveDistance + 18
  ]) {
    const client = await page.context().newCDPSession(page);
    const sourcePoint = await getLocatorTouchPoint(source);
    let touchStarted = false;

    try {
      await dispatchTouchPoint(client, "touchStart", sourcePoint);
      touchStarted = true;
      await page.waitForTimeout(mobileTouchDragActivationWaitMs);

      let currentPoint = {
        x: sourcePoint.x,
        y: Math.max(sourcePoint.y - activationOffset, 8)
      };

      if (currentPoint.y === sourcePoint.y) {
        currentPoint = {
          x: sourcePoint.x,
          y: Math.min(sourcePoint.y + activationOffset, viewportHeight - 8)
        };
      }

      await dispatchTouchPoint(client, "touchMove", currentPoint);
      await page.waitForTimeout(mobileTouchDragMoveSettleDelayMs);

      if (!(await isTaskDragActive(dragOverlay, taskCard))) {
        currentPoint = {
          x: Math.min(sourcePoint.x + Math.round(activationOffset / 2), viewportWidth - 8),
          y: currentPoint.y
        };
        await dispatchTouchPoint(client, "touchMove", currentPoint);
        await page.waitForTimeout(mobileTouchDragMoveSettleDelayMs);
      }

      if (!(await isTaskDragActive(dragOverlay, taskCard))) {
        await endTouchGesture(client);
        touchStarted = false;
        await page.waitForTimeout(mobileTouchDragDropSettleDelayMs);
        continue;
      }

      await expect(target).toBeVisible();

      for (let step = 1; step <= mobileTouchDragMoveSteps; step += 1) {
        const dragTargetPoint = await getLocatorTouchPoint(target, targetYRatio);
        currentPoint =
          step === mobileTouchDragMoveSteps
            ? dragTargetPoint
            : {
                x: Math.round(currentPoint.x + (dragTargetPoint.x - currentPoint.x) / 2),
                y: Math.round(currentPoint.y + (dragTargetPoint.y - currentPoint.y) / 2)
              };
        await dispatchTouchPoint(client, "touchMove", currentPoint);
        await page.waitForTimeout(
          step === mobileTouchDragMoveSteps ? mobileTouchDragDropSettleDelayMs : mobileTouchDragMoveSettleDelayMs
        );
      }

      await endTouchGesture(client);
      touchStarted = false;
      return;
    } finally {
      if (touchStarted) {
        await endTouchGesture(client);
      }
      await detachTouchClient(client);
    }
  }

  throw new Error("Mobile touch drag did not activate after retrying the long-press gesture.");
}

async function expectDragOverlayNearPoint(page: Page, expectedX: number, expectedY: number, tolerance = 40) {
  const dragOverlay = page.locator(".task-drag-overlay");
  await expect(dragOverlay).toBeVisible();
  const overlayBox = await dragOverlay.boundingBox();

  expect(overlayBox).not.toBeNull();
  const overlayCenterX = (overlayBox?.x ?? 0) + (overlayBox?.width ?? 0) / 2;
  const overlayCenterY = (overlayBox?.y ?? 0) + (overlayBox?.height ?? 0) / 2;

  expect(Math.abs(overlayCenterX - expectedX)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(overlayCenterY - expectedY)).toBeLessThanOrEqual(tolerance);
}

function taskCardSurface(card: Locator) {
  return card.locator(":scope > .task-card__surface-wrap > .task-card__surface");
}

function taskCardTitle(card: Locator) {
  return card.locator(":scope .task-card__title").first();
}

function taskCardNestTarget(card: Locator) {
  return card.locator(":scope > .task-card__surface-wrap > .task-card__nest-target");
}

test("board page autosaves cards and filters tasks", async ({ page }) => {
  const tasksWithReusableGlobalTag = structuredClone(tasks);
  tasksWithReusableGlobalTag.push({
    body: "Homepage refresh backlog.",
    createdAt: "2026-03-18T08:18:00.000Z",
    id: "task-project-2-1",
    laneId: laneId("project-2", "todo"),
    parentTaskId: null,
    position: 0,
    projectId: "project-2",
    ticketId: "ROAD-1",
    tags: [tag("global-brand", "amber")],
    title: "Refresh homepage copy",
    updatedAt: "2026-03-18T08:22:00.000Z"
  });

  await mockAuthenticated(page, {
    projects: projectsForGrid,
    tasks: tasksWithReusableGlobalTag
  });

  await page.goto(billingBoardPath);

  await expect(page).toHaveTitle("Billing cleanup | BBTodo");
  await expect(page.locator(".subnav__current-value")).toHaveText("Billing cleanup");
  await expect(page.getByRole("button", { exact: true, name: "Create Lane" })).toHaveCount(0);
  await expect(page.getByLabel("Search cards")).toBeVisible();
  await expect(page.getByLabel("Filter by tags")).toHaveAttribute("placeholder", "tag");
  await expect(page.locator(".board-column")).toHaveCount(4);

  const firstTaskCard = page.getByTestId("task-card-task-1");
  const laneDeleteButton = page.getByLabel("Delete lane In Progress");
  await expect(firstTaskCard.locator(".task-card__title")).toHaveText("[BILL-1] Review retry settings");
  await expect(firstTaskCard.locator(".task-tag")).toHaveText(["backend", "retry"]);
  await expect(firstTaskCard.locator(".task-card__timestamp")).toHaveCount(0);
  await expect(firstTaskCard.getByLabel("Delete task Review retry settings")).toHaveCount(0);
  await expect(page.getByLabel("Delete lane Todo")).toHaveCount(0);
  await expect(page.getByLabel("Delete lane Done")).toHaveCount(0);
  await expect(firstTaskCard).toHaveCSS("border-radius", "0px");
  await expect(firstTaskCard).toHaveCSS("padding-top", "10.4px");
  await expect(firstTaskCard).toHaveCSS("padding-bottom", "10.4px");
  await expect(firstTaskCard.locator(".task-card__title")).toHaveCSS("font-family", /Open Sans/);
  await expect(laneDeleteButton).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(laneDeleteButton).toHaveCSS("color", "rgb(47, 119, 116)");

  await page.getByLabel("Open account menu").click();
  await page.getByRole("button", { name: "Ember" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "ember");
  await expect(laneDeleteButton).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(laneDeleteButton).toHaveCSS("color", "rgb(184, 94, 63)");
  await page.getByRole("button", { name: "Midnight" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "midnight");
  await expect(laneDeleteButton).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(laneDeleteButton).toHaveCSS("color", "rgb(142, 229, 224)");
  await page.getByLabel("Open account menu").click();

  await firstTaskCard.click();
  await expect(page).toHaveURL(/\/projects\/BILL\/BILL-1$/);

  const editDialog = page.getByRole("dialog", { name: /Edit BILL-/ });
  const dialogPanel = page.locator(".dialog-panel--task-editor");
  const sourceTab = editDialog.getByRole("tab", { name: "Markdown source" });
  const previewTab = editDialog.getByRole("tab", { name: "Rendered preview" });
  const viewTabs = editDialog.locator(".task-editor__view-tabs");
  const bodyField = editDialog.locator(".field--editor");
  const bodyFieldLabel = editDialog.locator(".task-editor__field-label");
  const bodyTextarea = editDialog.getByLabel("Task body");
  const fullscreenButton = editDialog.getByRole("button", { name: "Enter full screen" });
  const tagInput = editDialog.getByLabel("Task tags");
  const taskEditorFooter = editDialog.locator(".task-editor__footer");
  const footerActions = editDialog.locator(".task-editor__footer-actions");
  const createdMeta = editDialog.locator(".task-editor__meta-item", { hasText: "Created" });
  const updatedMeta = editDialog.locator(".task-editor__meta-item", { hasText: "Updated" });
  const closeButton = editDialog.getByRole("button", { exact: true, name: "Close" });
  const saveButton = editDialog.getByRole("button", { name: "Save card" });
  const saveStatus = editDialog.getByTestId("task-editor-save-status");

  await expect(editDialog).toBeVisible();
  await expect(editDialog.getByRole("heading", { name: "Edit BILL-1" })).toBeVisible();
  await expect(taskEditorFooter.locator(".task-editor__meta")).toBeVisible();
  await expect(footerActions).toBeVisible();
  await expect(footerActions.locator(".dialog-actions")).toBeVisible();
  await expect(footerActions.getByTestId("task-editor-save-status")).toBeVisible();
  await expect(closeButton).toBeVisible();
  await expect(taskEditorFooter.getByRole("button", { name: "Save card" })).toBeVisible();
  await expect(saveStatus).toHaveText("All changes saved");
  await expect(viewTabs).toHaveCSS("border-top-width", "0px");
  await expect(sourceTab).toHaveCSS("border-top-width", "0px");
  await expect(previewTab).toHaveCSS("border-top-width", "0px");
  await expect(bodyField).toHaveCSS("row-gap", "8px");
  await expect(createdMeta).toContainText("Created");
  await expect(createdMeta.locator("time")).toHaveAttribute("datetime", "2026-03-18T07:00:00.000Z");
  await expect(createdMeta.locator("time")).toHaveText("2026-03-18T07:00:00.000Z");
  await expect(updatedMeta).toContainText("Updated");
  await expect(updatedMeta.locator("time")).toHaveAttribute("datetime", "2026-03-18T07:10:00.000Z");
  await expect(updatedMeta.locator("time")).toHaveText("2026-03-18T07:10:00.000Z");
  const bodyLabelBox = await bodyFieldLabel.boundingBox();
  const viewTabsBox = await viewTabs.boundingBox();
  const footerMetaBox = await taskEditorFooter.locator(".task-editor__meta").boundingBox();
  const initialDialogBox = await dialogPanel.boundingBox();
  const initialTextareaBox = await bodyTextarea.boundingBox();
  const closeButtonBackground = await closeButton.evaluate(
    (element) => window.getComputedStyle(element).backgroundImage
  );
  const saveButtonBackground = await saveButton.evaluate(
    (element) => window.getComputedStyle(element).backgroundImage
  );
  const saveStatusBox = await saveStatus.boundingBox();
  const saveButtonBox = await saveButton.boundingBox();
  expect(bodyLabelBox).not.toBeNull();
  expect(viewTabsBox).not.toBeNull();
  expect(footerMetaBox).not.toBeNull();
  expect(initialDialogBox).not.toBeNull();
  expect(initialTextareaBox).not.toBeNull();
  expect(closeButtonBackground).toContain("linear-gradient");
  expect(saveButtonBackground).toContain("linear-gradient");
  expect(closeButtonBackground).not.toBe(saveButtonBackground);
  expect(saveStatusBox).not.toBeNull();
  expect(saveButtonBox).not.toBeNull();
  expect(
    Math.abs(
      ((bodyLabelBox?.y ?? 0) + (bodyLabelBox?.height ?? 0) / 2) -
        ((viewTabsBox?.y ?? 0) + (viewTabsBox?.height ?? 0) / 2)
    )
  ).toBeLessThanOrEqual(2);
  expect(Math.abs((footerMetaBox?.y ?? 0) - (saveButtonBox?.y ?? 0))).toBeLessThanOrEqual(32);
  expect((footerMetaBox?.x ?? 0)).toBeLessThan((saveButtonBox?.x ?? 0));
  expect((saveStatusBox?.y ?? 0) + (saveStatusBox?.height ?? 0)).toBeLessThanOrEqual(
    (saveButtonBox?.y ?? 0) + 2
  );
  await expect(editDialog.getByLabel("Title")).toHaveValue("Review retry settings");
  await expect(editDialog.getByRole("button", { name: "Remove tag backend" })).toBeVisible();
  await expect(editDialog.getByRole("button", { name: "Remove tag retry" })).toBeVisible();
  await expect(editDialog.getByRole("button", { name: "Add tag ops" })).toBeVisible();
  await expect(editDialog.getByRole("button", { name: "Add tag global-brand" })).toBeVisible();
  await expect(editDialog.getByLabel("Task body")).toHaveValue("Callback logs mention **retry** scope.");
  await expect(sourceTab).toHaveAttribute("aria-selected", "true");
  await expect(previewTab).toHaveAttribute("aria-selected", "false");
  await fullscreenButton.click();
  await expect(editDialog.getByRole("button", { name: "Exit full screen" })).toBeVisible();
  const fullscreenDialogBox = await dialogPanel.boundingBox();
  const fullscreenTextareaBox = await bodyTextarea.boundingBox();
  expect(fullscreenDialogBox).not.toBeNull();
  expect(fullscreenTextareaBox).not.toBeNull();
  expect((fullscreenDialogBox?.width ?? 0)).toBeGreaterThan((initialDialogBox?.width ?? 0) + 120);
  expect((fullscreenTextareaBox?.width ?? 0)).toBeGreaterThan((initialTextareaBox?.width ?? 0) + 120);

  await editDialog.getByRole("button", { name: "Edit color for tag backend" }).click();
  await editDialog.getByRole("button", { name: "Set backend color to Amber" }).click();
  await previewTab.click();
  await expect(previewTab).toHaveAttribute("aria-selected", "true");
  await expect(editDialog.locator(".markdown-preview strong")).toHaveText("retry");
  await sourceTab.click();
  await editDialog.getByRole("button", { name: "Add tag ops" }).click();
  await expect(editDialog.getByRole("button", { name: "Remove tag ops" })).toBeVisible();
  await editDialog.getByRole("button", { name: "Remove tag retry" }).click();
  await editDialog.getByRole("button", { name: "Remove tag ops" }).click();
  await editDialog.getByLabel("Title").fill("Review retry scope");
  await tagInput.fill("release");
  await expect(editDialog.getByText("Color for release")).toBeVisible();
  await editDialog.getByRole("button", { name: "Set release color to Orchid" }).click();
  await tagInput.press("Enter");
  await expect(editDialog.getByRole("button", { name: "Remove tag release" })).toBeVisible();
  await editDialog
    .getByLabel("Task body")
    .fill("Callback logs mention **scope**.\n\n- Keep raw claims\n- Verify issuer");
  await previewTab.click();
  await expect(editDialog.locator(".markdown-preview strong")).toHaveText("scope");
  await expect(editDialog.locator(".markdown-preview li")).toHaveCount(2);
  await expect(saveStatus).toHaveText("Unsaved changes");
  await expect(saveButton).toHaveText("Save card");
  await expect(saveStatus).toHaveText("All changes saved");
  await closeButton.click();

  await expect(editDialog).toHaveCount(0);
  await expect(firstTaskCard.locator(".task-card__title")).toHaveText("[BILL-1] Review retry scope");
  const updatedTaskTags = firstTaskCard.locator(".task-tag");
  await expect(updatedTaskTags).toHaveText(["backend", "release"]);
  await expect(updatedTaskTags.nth(0)).toHaveCSS("background-color", "rgb(255, 241, 217)");
  await expect(updatedTaskTags.nth(1)).toHaveCSS("background-color", "rgb(242, 229, 255)");

  await page.getByTestId("task-card-task-2").click();
  const recoloredBackendSuggestion = editDialog.getByRole("button", { name: "Add tag backend" });
  await expect(editDialog).toBeVisible();
  await expect(recoloredBackendSuggestion).toHaveCSS("background-color", "rgb(255, 241, 217)");
  await editDialog.getByLabel("Close edit task dialog").click();
  await expect(editDialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/projects\/BILL$/);

  await page.getByLabel("Search cards").fill("callback");
  await expect(page.getByText("Review retry scope")).toBeVisible();
  await expect(page.getByText("Tighten callback logging")).toBeVisible();
  await expect(page.getByText("Remove healthcheck loop")).toHaveCount(0);

  await page.getByLabel("Search cards").fill("");

  const tagFilterField = page.locator(".subnav__search--tag-filter");
  await page.getByRole("button", { name: "Show tag filter suggestions" }).click();
  const tagFilterDropdown = page.getByRole("list", { name: "Available tag filters" });
  await expect(tagFilterDropdown.getByRole("button", { name: "Add tag filter release" })).toBeVisible();
  await expect(tagFilterDropdown.getByRole("button", { name: "Add tag filter global-brand" })).toBeVisible();
  await tagFilterDropdown.getByRole("button", { name: "Add tag filter release" }).click();

  const releaseTagFilterChip = tagFilterField.locator(".subnav__tag-filter-chip", { hasText: "release" });
  await expect(releaseTagFilterChip).toBeVisible();
  await expect(page.getByText("Review retry scope")).toBeVisible();
  await expect(page.getByText("Tighten callback logging")).toHaveCount(0);
  await expect(page.getByText("Queue copy pass")).toHaveCount(0);

  await firstTaskCard.locator(".task-tag", { hasText: "backend" }).click({ force: true });
  const backendTagFilterChip = tagFilterField.locator(".subnav__tag-filter-chip", { hasText: "backend" });
  await expect(releaseTagFilterChip).toHaveCount(0);
  await expect(backendTagFilterChip).toBeVisible();
  await expect(page.getByText("Review retry scope")).toBeVisible();
  await expect(page.getByText("Tighten callback logging")).toHaveCount(0);
  await expect(page.getByText("Queue copy pass")).toHaveCount(0);

  await page.goto(`${billingBoardPath}?tags=ops,backend`);
  const routedOpsTagFilterChip = tagFilterField.locator(".subnav__tag-filter-chip", { hasText: "ops" });
  await expect(routedOpsTagFilterChip).toBeVisible();
  await expect(page.getByText("Remove healthcheck loop")).toBeVisible();
  await expect(page.getByText("Review retry scope")).toHaveCount(0);
});

test("board page flushes pending task edits when closing the dialog", async ({ page }) => {
  await mockAuthenticated(page, {
    projects: projectsForGrid,
    taskPatchDelayMs: 250,
    tasks
  });

  await page.goto(`${billingBoardPath}/BILL-2`);

  const editDialog = page.getByRole("dialog", { name: "Edit BILL-2" });
  const saveStatus = editDialog.getByTestId("task-editor-save-status");

  await expect(editDialog).toBeVisible();
  await editDialog.getByLabel("Title").fill("Tighten callback traces");
  await editDialog.getByLabel("Task tags").fill("urgent");
  await expect(saveStatus).toHaveText("Unsaved changes");

  await editDialog.getByRole("button", { exact: true, name: "Close" }).click();

  await expect(editDialog).toBeVisible();
  await expect(saveStatus).toHaveText("Saving...");
  await expect(editDialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/projects\/BILL$/);

  await page.goto(`${billingBoardPath}/BILL-2`);
  await expect(editDialog).toBeVisible();
  await expect(editDialog.getByLabel("Title")).toHaveValue("Tighten callback traces");
  await expect(editDialog.getByRole("button", { name: "Remove tag urgent" })).toBeVisible();
});

test("board page keeps autosave failures open and allows manual retry", async ({ page }) => {
  await mockAuthenticated(page, {
    projects: projectsForGrid,
    taskPatchFailuresById: {
      "task-1": 1
    },
    tasks
  });

  await page.goto(`${billingBoardPath}/BILL-1`);

  const editDialog = page.getByRole("dialog", { name: "Edit BILL-1" });
  const saveStatus = editDialog.getByTestId("task-editor-save-status");

  await expect(editDialog).toBeVisible();
  await editDialog.getByLabel("Title").fill("Review retry rollout");
  await expect(saveStatus).toHaveText("Unsaved changes");
  await expect(saveStatus).toHaveText("Save failed");
  await expect(editDialog.getByText("Task save failed.")).toBeVisible();
  await expect(editDialog).toBeVisible();

  await editDialog.getByRole("button", { name: "Save card" }).click();
  await expect(saveStatus).toHaveText("All changes saved");

  await editDialog.getByRole("button", { exact: true, name: "Close" }).click();
  await expect(editDialog).toHaveCount(0);
  await expect(page.getByTestId("task-card-task-1").locator(".task-card__title")).toHaveText(
    "[BILL-1] Review retry rollout"
  );
});

test("board page opens a task dialog from a ticket deep link", async ({ page }) => {
  await mockAuthenticated(page, {
    projects: projectsForGrid,
    tasks
  });

  await page.goto(`${billingBoardPath}/BILL-2?q=callback`);

  const editDialog = page.getByRole("dialog", { name: "Edit BILL-2" });

  await expect(editDialog).toBeVisible();
  await expect(page).toHaveURL(/\/projects\/BILL\/BILL-2\?q=callback$/);
  await expect(editDialog.getByRole("heading", { name: "Edit BILL-2" })).toBeVisible();
  await expect(editDialog.getByLabel("Title")).toHaveValue("Tighten callback logging");
  await expect(page.getByLabel("Search cards")).toHaveValue("callback");

  await editDialog.getByLabel("Close edit task dialog").click();

  await expect(editDialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/projects\/BILL\?q=callback$/);
});

test("board page moves a card to another project from the editor and keeps the dialog open", async ({
  page
}) => {
  await mockAuthenticated(page, {
    projects: projectsForGrid,
    tasks
  });

  await page.goto(`${billingBoardPath}/BILL-2`);

  const editDialog = page.getByRole("dialog");

  await expect(editDialog).toBeVisible();
  await expect(editDialog.getByLabel("Destination board")).toHaveCount(0);
  await expect(editDialog.getByRole("button", { name: "Move card" })).toHaveCount(0);

  const moveTrigger = editDialog.getByTestId("move-card-trigger");
  const moveTriggerStyles = await moveTrigger.evaluate((element) => {
    const styles = window.getComputedStyle(element);
    return {
      backgroundImage: styles.backgroundImage,
      boxShadow: styles.boxShadow
    };
  });
  expect(moveTriggerStyles.backgroundImage).not.toBe("none");
  expect(moveTriggerStyles.boxShadow).not.toBe("none");

  await moveTrigger.click();

  const movePopover = editDialog.getByTestId("move-card-popover");
  await expect(movePopover).toBeVisible();
  await expect(movePopover.getByTestId("move-card-lane-preview")).toHaveCount(0);
  await expect(movePopover.getByTestId("move-card-summary")).toHaveCount(0);
  const movePopoverFont = await movePopover.evaluate((element) => window.getComputedStyle(element).fontFamily);
  expect(movePopoverFont).toContain("Open Sans");
  const movePopoverBounds = await movePopover.evaluate((element) => {
    const popoverRect = element.getBoundingClientRect();
    const input = element.querySelector('input[aria-label="Destination board"]');
    const actions = element.querySelector(".task-delete-popover__actions");
    const projectList = element.querySelector('[data-testid="move-card-project-list"]');
    const firstProjectCopy = element.querySelector(".task-editor__move-project-copy");

    if (
      !(input instanceof HTMLElement) ||
      !(actions instanceof HTMLElement) ||
      !(projectList instanceof HTMLElement) ||
      !(firstProjectCopy instanceof HTMLElement)
    ) {
      throw new Error("Expected move popover content to exist");
    }

    const inputRect = input.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    const projectListRect = projectList.getBoundingClientRect();

    return {
      actionsBottom: actionsRect.bottom,
      actionsLeft: actionsRect.left,
      actionsRight: actionsRect.right,
      actionsTop: actionsRect.top,
      firstProjectCopyDisplay: window.getComputedStyle(firstProjectCopy).display,
      popoverBottom: popoverRect.bottom,
      popoverLeft: popoverRect.left,
      popoverRight: popoverRect.right,
      popoverTop: popoverRect.top,
      inputBottom: inputRect.bottom,
      inputLeft: inputRect.left,
      inputRight: inputRect.right,
      inputTop: inputRect.top,
      projectListBottom: projectListRect.bottom,
      projectListLeft: projectListRect.left,
      projectListRight: projectListRect.right,
      projectListTop: projectListRect.top
    };
  });
  expect(movePopoverBounds.inputTop).toBeGreaterThanOrEqual(movePopoverBounds.popoverTop - 1);
  expect(movePopoverBounds.inputLeft).toBeGreaterThanOrEqual(movePopoverBounds.popoverLeft - 1);
  expect(movePopoverBounds.inputRight).toBeLessThanOrEqual(movePopoverBounds.popoverRight + 1);
  expect(movePopoverBounds.inputBottom).toBeLessThanOrEqual(movePopoverBounds.popoverBottom + 1);
  expect(movePopoverBounds.projectListTop).toBeGreaterThanOrEqual(movePopoverBounds.popoverTop - 1);
  expect(movePopoverBounds.projectListLeft).toBeGreaterThanOrEqual(movePopoverBounds.popoverLeft - 1);
  expect(movePopoverBounds.projectListRight).toBeLessThanOrEqual(movePopoverBounds.popoverRight + 1);
  expect(movePopoverBounds.projectListBottom).toBeLessThanOrEqual(movePopoverBounds.popoverBottom + 1);
  expect(movePopoverBounds.actionsTop).toBeGreaterThanOrEqual(movePopoverBounds.popoverTop - 1);
  expect(movePopoverBounds.actionsLeft).toBeGreaterThanOrEqual(movePopoverBounds.popoverLeft - 1);
  expect(movePopoverBounds.actionsRight).toBeLessThanOrEqual(movePopoverBounds.popoverRight + 1);
  expect(movePopoverBounds.actionsBottom).toBeLessThanOrEqual(movePopoverBounds.popoverBottom + 1);
  expect(movePopoverBounds.firstProjectCopyDisplay).toBe("flex");

  await movePopover.getByLabel("Destination board").fill("road");
  await movePopover.getByTestId("move-card-project-option-project-2").click();
  await expect(movePopover.getByTestId("move-card-lane-preview")).toBeVisible();
  await expect(movePopover.getByTestId("move-card-lane-preview")).toHaveText("In Progress");
  await expectMoveLanePreviewCentered(movePopover.locator(".task-editor__move-preview"));
  await expect(movePopover.getByTestId("move-card-summary")).toHaveCount(0);

  await movePopover.getByRole("button", { name: "Move card" }).click();

  await expect(page).toHaveURL(/\/projects\/ROAD\/ROAD-1$/);
  const moveToast = page.getByTestId("toast-notice");
  await expect(moveToast).toBeVisible();
  await expect(moveToast).toContainText("Card moved");
  await expect(moveToast).toContainText("BILL-2 has been moved to ROAD-1.");
  await expect(moveToast).not.toContainText("Ticket not found");
  await expect(editDialog).toBeVisible();
  await expect(editDialog.getByRole("heading", { name: "Edit ROAD-1" })).toBeVisible();
  await expect(editDialog.getByLabel("Title")).toHaveValue("Tighten callback logging");
  await expect(page.getByLabel("Search cards")).toHaveValue("");

  await editDialog.getByLabel("Close edit task dialog").click();
  await expect(page).toHaveURL(/\/projects\/ROAD$/);
  await expect(page.getByTestId("task-card-task-2").locator(".task-card__title")).toHaveText(
    "[ROAD-1] Tighten callback logging"
  );

  await page.goto("/projects/BILL");
  await expect(page.getByTestId("task-card-task-2")).toHaveCount(0);
});

test("board page previews Todo fallback when moving a card to a project without the same lane", async ({
  page
}) => {
  const projectsWithQaLane = structuredClone(projectsForGrid);
  const billingProject = projectsWithQaLane.find((project) => project.id === "project-1");
  if (!billingProject) {
    throw new Error("Expected project-1 test fixture to exist");
  }

  const qaLaneId = "project-1-lane-custom-qa";
  billingProject.laneSummaries = [
    ...billingProject.laneSummaries.map((laneSummary) =>
      laneSummary.id === laneId("project-1", "todo")
        ? {
            ...laneSummary,
            taskCount: 1
          }
        : laneSummary
    ),
    {
      createdAt: "2026-03-18T08:00:00.000Z",
      id: qaLaneId,
      name: "Ready for QA",
      position: 4,
      projectId: "project-1",
      taskCount: 1,
      updatedAt: "2026-03-18T08:00:00.000Z"
    }
  ];

  const tasksWithQaLane = structuredClone(tasks);
  const qaTask = tasksWithQaLane.find((task) => task.id === "task-1");
  if (!qaTask) {
    throw new Error("Expected task-1 fixture to exist");
  }

  qaTask.laneId = qaLaneId;
  qaTask.position = 0;

  await mockAuthenticated(page, {
    projects: projectsWithQaLane,
    tasks: tasksWithQaLane
  });

  await page.goto(`${billingBoardPath}/BILL-1`);

  const editDialog = page.getByRole("dialog");

  await expect(editDialog).toBeVisible();
  await expect(editDialog.getByLabel("Destination board")).toHaveCount(0);

  await editDialog.getByRole("button", { exact: true, name: "Move" }).click();

  const movePopover = editDialog.getByTestId("move-card-popover");
  await expect(movePopover).toBeVisible();
  await expect(movePopover.getByTestId("move-card-lane-preview")).toHaveCount(0);
  await movePopover.getByLabel("Destination board").fill("road");
  await movePopover.getByTestId("move-card-project-option-project-2").click();
  await expect(movePopover.getByTestId("move-card-lane-preview")).toBeVisible();
  await expect(movePopover.getByTestId("move-card-lane-preview")).toHaveText("Todo");
  await expectMoveLanePreviewCentered(movePopover.locator(".task-editor__move-preview"));
  await expect(movePopover.getByTestId("move-card-summary")).toHaveCount(0);

  await movePopover.getByRole("button", { name: "Move card" }).click();

  await expect(page).toHaveURL(/\/projects\/ROAD\/ROAD-1$/);
  const moveToast = page.getByTestId("toast-notice");
  await expect(moveToast).toBeVisible();
  await expect(moveToast).toContainText("Card moved");
  await expect(moveToast).toContainText("BILL-1 has been moved to ROAD-1.");
  await expect(moveToast).not.toContainText("Ticket not found");
  const nextDialog = page.getByRole("dialog");
  await expect(nextDialog).toBeVisible();
  await nextDialog.getByLabel("Close edit task dialog").click();
  await expect(page.getByTestId(`board-column-${laneId("project-2", "todo")}`)).toContainText(
    "[ROAD-1] Review retry settings"
  );
});

test("board page move picker shows five boards by default and searches the rest", async ({
  page
}) => {
  const projectsWithManyBoards = structuredClone(projectsForGrid);
  for (const [index, projectConfig] of [
    { id: "project-3", name: "Backlog prep", ticketPrefix: "BPRE" },
    { id: "project-4", name: "Client ops", ticketPrefix: "COPS" },
    { id: "project-5", name: "Design system", ticketPrefix: "DSGN" },
    { id: "project-6", name: "Fulfillment sweep", ticketPrefix: "FLFM" },
    { id: "project-7", name: "Growth experiments", ticketPrefix: "GWTH" },
    { id: "project-8", name: "Incident coordination", ticketPrefix: "IDCT" }
  ].entries()) {
    projectsWithManyBoards.push({
      createdAt: `2026-03-17T1${index}:00:00.000Z`,
      id: projectConfig.id,
      laneSummaries: [
        {
          createdAt: "2026-03-17T09:00:00.000Z",
          id: laneId(projectConfig.id, "todo"),
          name: "Todo",
          position: 0,
          projectId: projectConfig.id,
          taskCount: 0,
          updatedAt: "2026-03-18T07:30:00.000Z"
        },
        {
          createdAt: "2026-03-17T09:00:00.000Z",
          id: laneId(projectConfig.id, "in_progress"),
          name: "In Progress",
          position: 1,
          projectId: projectConfig.id,
          taskCount: 0,
          updatedAt: "2026-03-18T07:30:00.000Z"
        },
        {
          createdAt: "2026-03-17T09:00:00.000Z",
          id: laneId(projectConfig.id, "in_review"),
          name: "In review",
          position: 2,
          projectId: projectConfig.id,
          taskCount: 0,
          updatedAt: "2026-03-18T07:30:00.000Z"
        },
        {
          createdAt: "2026-03-17T09:00:00.000Z",
          id: laneId(projectConfig.id, "done"),
          name: "Done",
          position: 3,
          projectId: projectConfig.id,
          taskCount: 0,
          updatedAt: "2026-03-18T07:30:00.000Z"
        }
      ],
      name: projectConfig.name,
      ticketPrefix: projectConfig.ticketPrefix,
      updatedAt: "2026-03-18T08:10:00.000Z"
    });
  }

  await mockAuthenticated(page, {
    projects: projectsWithManyBoards,
    tasks
  });

  await page.goto(`${billingBoardPath}/BILL-2`);

  const editDialog = page.getByRole("dialog");
  await expect(editDialog).toBeVisible();
  await editDialog.getByRole("button", { exact: true, name: "Move" }).click();

  const movePopover = editDialog.getByTestId("move-card-popover");
  await expect(movePopover).toBeVisible();
  await expect(movePopover.getByTestId("move-card-project-list").locator("button")).toHaveCount(5);
  await expect(movePopover.getByTestId("move-card-project-option-project-8")).toHaveCount(0);

  await movePopover.getByLabel("Destination board").fill("incident");
  await expect(movePopover.getByTestId("move-card-project-list").locator("button")).toHaveCount(1);
  await movePopover.getByTestId("move-card-project-option-project-8").click();
  await expect(movePopover.getByTestId("move-card-lane-preview")).toHaveText("In Progress");
});

test("board page search opens an exact ticket id across boards", async ({ page }) => {
  const tasksWithRoadmapCard = structuredClone(tasks);
  tasksWithRoadmapCard.push({
    body: "Lock the launch sequence before the next review.",
    createdAt: "2026-03-18T08:05:00.000Z",
    id: "task-5",
    laneId: laneId("project-2", "todo"),
    parentTaskId: null,
    position: 0,
    projectId: "project-2",
    ticketId: "ROAD-1",
    tags: [tag("planning", "amber")],
    title: "Confirm launch timeline",
    updatedAt: "2026-03-18T08:20:00.000Z"
  });

  await mockAuthenticated(page, {
    projects: projectsForGrid,
    tasks: tasksWithRoadmapCard
  });

  await page.goto(billingBoardPath);

  const searchInput = page.getByLabel("Search cards");
  await searchInput.fill("road-1");

  const editDialog = page.getByRole("dialog", { name: "Edit ROAD-1" });

  await expect(page).toHaveURL(/\/projects\/BILL\?q=road-1$/);
  await expect(editDialog).toHaveCount(0);

  await searchInput.press("Enter");

  await expect(page).toHaveURL(/\/projects\/ROAD\/ROAD-1\?q=ROAD-1$/);
  await expect(editDialog).toBeVisible();
  await expect(editDialog.getByLabel("Title")).toHaveValue("Confirm launch timeline");
  await expect(page.getByLabel("Search cards")).toHaveValue("ROAD-1");

  await page.getByLabel("Close edit task dialog").click();

  await expect(page).toHaveURL(/\/projects\/ROAD\?q=ROAD-1$/);
  await expect(page.getByTestId("task-card-task-5")).toBeVisible();
  await expect(page.getByTestId("task-card-task-1")).toHaveCount(0);
});

test("board page shows a toast when a ticket deep link misses", async ({ page }) => {
  await mockAuthenticated(page, {
    projects: projectsForGrid,
    tasks
  });

  await page.goto(`${billingBoardPath}/BILL-99?q=callback`);

  const toast = page.getByTestId("toast-notice");

  await expect(page).toHaveURL(/\/projects\/BILL\?q=callback$/);
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("Ticket not found");
  await expect(toast).toContainText("Ticket BILL-99 does not exist.");
  await expect(page.getByRole("dialog", { name: /Edit BILL-/ })).toHaveCount(0);
  await expect(page.getByLabel("Search cards")).toHaveValue("callback");
});

test("board page redirects home with a toast when the board route is invalid", async ({ page }) => {
  await mockAuthenticated(page, {
    projects: projectsForGrid,
    tasks
  });

  await page.goto("/projects/project-1");

  const toast = page.getByTestId("toast-notice");

  await expect(page).toHaveURL("/");
  await expect(page.locator(".subnav__current-value")).toHaveText("All projects");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("Board not found");
  await expect(toast).toContainText("Board project-1 does not exist.");
});

test("board page deletes tasks from the lane header trash target", async ({ page }) => {
  await mockAuthenticated(page, {
    projects: projectsForGrid,
    tasks
  });

  await page.goto(billingBoardPath);

  const firstTaskCard = page.getByTestId("task-card-task-1");
  const todoLaneHeader = page.getByTestId(`lane-header-${laneId("project-1", "todo")}`);
  const doneLaneHeader = page.getByTestId(`lane-header-${laneId("project-1", "done")}`);
  const todoLaneTrashTarget = page.getByTestId(`lane-task-trash-target-${laneId("project-1", "todo")}`);
  const doneLaneTrashTarget = page.getByTestId(`lane-task-trash-target-${laneId("project-1", "done")}`);

  await expect(firstTaskCard.getByLabel("Delete task Review retry settings")).toHaveCount(0);
  await expect(todoLaneTrashTarget).toBeHidden();
  await expect(doneLaneTrashTarget).toBeHidden();

  await beginTaskDrag(page, taskCardSurface(firstTaskCard));
  await expect(page.locator(".task-drag-overlay .task-card__title")).toHaveText(
    "[BILL-1] Review retry settings"
  );
  await expect(todoLaneHeader).toHaveClass(/is-task-trash-visible/);
  await expect(doneLaneHeader).not.toHaveClass(/is-task-trash-visible/);
  await expect(todoLaneTrashTarget).toBeVisible();
  await expect(doneLaneTrashTarget).toBeHidden();
  await expect(todoLaneTrashTarget).toHaveCSS("border-top-width", "0px");
  const todoHeaderBox = await todoLaneHeader.boundingBox();
  const todoTrashBox = await todoLaneTrashTarget.boundingBox();
  expect(todoHeaderBox).not.toBeNull();
  expect(todoTrashBox).not.toBeNull();
  const todoHeaderCenterX = (todoHeaderBox?.x ?? 0) + (todoHeaderBox?.width ?? 0) / 2;
  const todoHeaderCenterY = (todoHeaderBox?.y ?? 0) + (todoHeaderBox?.height ?? 0) / 2;
  const todoTrashCenterX = (todoTrashBox?.x ?? 0) + (todoTrashBox?.width ?? 0) / 2;
  const todoTrashCenterY = (todoTrashBox?.y ?? 0) + (todoTrashBox?.height ?? 0) / 2;
  expect(Math.abs(todoHeaderCenterX - todoTrashCenterX)).toBeLessThanOrEqual(8);
  expect(Math.abs(todoHeaderCenterY - todoTrashCenterY)).toBeLessThanOrEqual(6);
  await dropDraggedTaskOnHeaderTrashZone(page, todoLaneHeader);

  const deleteDialog = page.getByRole("alertdialog", { name: "Delete task Review retry settings" });
  await expect(deleteDialog).toBeVisible();
  await deleteDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(firstTaskCard).toBeVisible();
  await expect(todoLaneTrashTarget).toBeHidden();

  await beginTaskDrag(page, taskCardSurface(firstTaskCard));
  await expect(todoLaneHeader).toHaveClass(/is-task-trash-visible/);
  await dropDraggedTaskOnHeaderTrashZone(page, todoLaneHeader);

  await expect(deleteDialog).toBeVisible();
  await deleteDialog.getByRole("button", { exact: true, name: "Delete" }).click();
  await expect(firstTaskCard).toHaveCount(0);
  await expect(page.getByTestId("task-card-task-4")).toBeVisible();
  await expect(todoLaneTrashTarget).toBeHidden();
  const taskDeleteToast = page.getByTestId("toast-notice");
  await expect(taskDeleteToast).toBeVisible();
  await expect(taskDeleteToast).toContainText("Task deleted");
  await expect(taskDeleteToast).toContainText("Review retry settings (BILL-1) was deleted.");
});

test("board page previews same-lane reordering with an overlay that follows the pointer", async ({ page }) => {
  const tasksWithLockedParent = structuredClone(tasks);
  tasksWithLockedParent.push({
    body: "",
    createdAt: "2026-03-18T08:10:00.000Z",
    id: "task-7",
    laneId: laneId("project-1", "todo"),
    parentTaskId: "task-1",
    position: 0,
    projectId: "project-1",
    ticketId: "BILL-7",
    tags: [],
    title: "Nested retry note",
    updatedAt: "2026-03-18T08:10:00.000Z"
  });

  await mockAuthenticated(page, {
    projects: projectsForGrid,
    tasks: tasksWithLockedParent
  });

  await page.goto(billingBoardPath);

  const todoColumn = page.getByTestId(`board-column-${laneId("project-1", "todo")}`);
  const retryCard = page.getByTestId("task-card-task-1");
  const copyCard = page.getByTestId("task-card-task-4");
  const todoAfterCopySlot = page.getByTestId(`task-drop-slot-${laneId("project-1", "todo")}-2`);
  const retryBox = await retryCard.boundingBox();

  expect(retryBox).not.toBeNull();

  await beginTaskDrag(page, taskCardSurface(retryCard));
  await hoverDraggedTaskOver(page, taskCardSurface(copyCard), 0.2);

  const copySurfaceBox = await taskCardSurface(copyCard).boundingBox();
  expect(copySurfaceBox).not.toBeNull();

  await expect(retryCard).toHaveClass(/is-dragging/);
  await expect(copyCard).toHaveClass(/task-card--drop-after/);
  await expect(copyCard).toHaveClass(/task-card--shift-up/);
  await expect(todoAfterCopySlot).toHaveClass(/is-active/);
  await expect(todoAfterCopySlot).toHaveClass(/is-drag-ready/);
  await expect(page.locator(".page-shell--board")).toHaveClass(/is-task-dragging/);
  const dragStyles = await page.evaluate(() => {
    const sourceCard = document.querySelector<HTMLElement>("[data-testid='task-card-task-1']");
    const overlayCard = document.querySelector<HTMLElement>(".task-drag-overlay .task-card");

    if (!sourceCard || !overlayCard) {
      throw new Error("Expected dragged source card and overlay card to be present.");
    }

    return {
      overlayAnimationName: window.getComputedStyle(overlayCard).animationName,
      sourceAnimationName: window.getComputedStyle(sourceCard).animationName
    };
  });

  expect(dragStyles.sourceAnimationName).toBe("none");
  expect(dragStyles.overlayAnimationName).toBe("none");
  await expectDragOverlayNearPoint(
    page,
    (copySurfaceBox?.x ?? 0) + (copySurfaceBox?.width ?? 0) / 2,
    (copySurfaceBox?.y ?? 0) + (copySurfaceBox?.height ?? 0) * 0.2,
    44
  );
  const retryBoxAfterHover = await retryCard.boundingBox();
  const dragOverlayBox = await page.locator(".task-drag-overlay").boundingBox();

  expect(retryBoxAfterHover).not.toBeNull();
  expect(dragOverlayBox).not.toBeNull();
  expect(Math.abs((retryBoxAfterHover?.x ?? 0) - (retryBox?.x ?? 0))).toBeLessThanOrEqual(8);
  expect(
    Math.abs(
      ((dragOverlayBox?.y ?? 0) + (dragOverlayBox?.height ?? 0) / 2) -
        ((retryBoxAfterHover?.y ?? 0) + (retryBoxAfterHover?.height ?? 0) / 2)
    )
  ).toBeGreaterThan(40);

  await finishTaskDrag(page);

  await expect(todoColumn.locator(".task-card__title")).toHaveText([
    "[BILL-4] Queue copy pass",
    "[BILL-1] Review retry settings",
    "[BILL-7] Nested retry note"
  ]);
});

test("board page reorders with seams when a standalone task could otherwise nest", async ({ page }) => {
  await mockAuthenticated(page, {
    projects: projectsForGrid,
    tasks
  });

  await page.goto(billingBoardPath);

  const todoColumn = page.getByTestId(`board-column-${laneId("project-1", "todo")}`);
  const retryCard = page.getByTestId("task-card-task-1");
  const todoAfterCopySlot = page.getByTestId(`task-drop-slot-${laneId("project-1", "todo")}-2`);
  const copySubtaskSlot = page.getByTestId("task-drop-slot-task-4-0");

  await beginTaskDrag(page, taskCardSurface(retryCard));
  await hoverDraggedTaskOver(page, todoAfterCopySlot, 0.5);

  await expect(todoAfterCopySlot).toHaveClass(/is-active/);
  await expect(todoAfterCopySlot).toHaveClass(/is-drag-ready/);
  await expect(copySubtaskSlot).toHaveCount(0);

  await finishTaskDrag(page);

  await expect(todoColumn.locator(".task-card__title")).toHaveText([
    "[BILL-4] Queue copy pass",
    "[BILL-1] Review retry settings"
  ]);
});

test("board page allows dragging another card while an earlier move is still pending", async ({ page }) => {
  await mockAuthenticated(page, {
    projects: projectsForGrid,
    taskMoveDelayMs: 1200,
    tasks
  });

  await page.goto(billingBoardPath);

  const inProgressColumn = page.getByTestId(`board-column-${laneId("project-1", "in_progress")}`);
  const inReviewColumn = page.getByTestId(`board-column-${laneId("project-1", "in_review")}`);
  const retryCard = page.getByTestId("task-card-task-1");
  const copyCard = page.getByTestId("task-card-task-4");
  const inProgressAfterExistingCardSlot = page.getByTestId(`task-drop-slot-${laneId("project-1", "in_progress")}-1`);
  const inReviewTopSlot = page.getByTestId(`task-drop-slot-${laneId("project-1", "in_review")}-0`);

  await dragTaskToTarget(page, taskCardSurface(retryCard), inProgressAfterExistingCardSlot);
  await expect(inProgressColumn.locator(".task-card__title")).toHaveText([
    "[BILL-2] Tighten callback logging",
    "[BILL-1] Review retry settings"
  ]);

  await beginTaskDrag(page, taskCardSurface(copyCard));
  await expect(copyCard).toHaveClass(/is-dragging/);
  await hoverDraggedTaskOver(page, inReviewTopSlot);
  await finishTaskDrag(page);

  await expect(inProgressColumn.locator(".task-card__title")).toHaveText([
    "[BILL-2] Tighten callback logging",
    "[BILL-1] Review retry settings"
  ]);
  await expect(inReviewColumn.locator(".task-card__title")).toHaveText(["[BILL-4] Queue copy pass"]);
});

test("board page reorders tasks and manages lanes", async ({ page }) => {
  const projectsWithQaLane = structuredClone(projectsForGrid);
  const tasksWithQaCard = structuredClone(tasks);
  const billingCleanupProject = projectsWithQaLane.find((project) => project.id === "project-1");
  if (!billingCleanupProject) {
    throw new Error("Expected project-1 test fixture to exist");
  }

  billingCleanupProject.laneSummaries.push({
    createdAt: "2026-03-18T08:00:00.000Z",
    id: "project-1-lane-custom-1",
    name: "Ready for QA",
    position: 4,
    projectId: "project-1",
    taskCount: 0,
    updatedAt: "2026-03-18T08:00:00.000Z"
  });

  tasksWithQaCard.push({
    body: "",
    createdAt: "2026-03-18T08:00:00.000Z",
    id: "task-5",
    laneId: "project-1-lane-custom-1",
    parentTaskId: null,
    position: 0,
    projectId: "project-1",
    ticketId: "BILL-5",
    tags: [],
    title: "Ship note",
    updatedAt: "2026-03-18T08:00:00.000Z"
  });
  tasksWithQaCard.push({
    body: "",
    createdAt: "2026-03-18T08:05:00.000Z",
    id: "task-6",
    laneId: "project-1-lane-custom-1",
    parentTaskId: null,
    position: 1,
    projectId: "project-1",
    ticketId: "BILL-6",
    tags: [],
    title: "Release checklist",
    updatedAt: "2026-03-18T08:05:00.000Z"
  });

  await mockAuthenticated(page, {
    projects: projectsWithQaLane,
    tasks: tasksWithQaCard
  });

  await page.goto(billingBoardPath);

  const todoColumn = page.getByTestId(`board-column-${laneId("project-1", "todo")}`);
  const retryCard = page.getByTestId("task-card-task-1");
  await expect(todoColumn.getByText("Review retry settings")).toBeVisible();

  const laneHeadings = page.locator(".board-column__header h2");
  await expect(laneHeadings).toHaveText(["Todo", "In Progress", "In review", "Done", "Ready for QA"]);

  const qaColumn = page.getByTestId("board-column-project-1-lane-custom-1");
  const qaContent = qaColumn.locator(".board-column__content");
  const doneColumn = page.getByTestId(`board-column-${laneId("project-1", "done")}`);
  const shipNoteSubtaskSlot = page.getByTestId("task-drop-slot-task-5-0");

  const createdCard = page.getByTestId("task-card-task-5");
  const releaseChecklistCard = page.getByTestId("task-card-task-6");
  const copyCard = page.getByTestId("task-card-task-4");
  await expect(createdCard).toBeVisible();
  await expect(releaseChecklistCard).toBeVisible();
  await expect(createdCard.locator(".task-tag")).toHaveCount(0);

  await dragTaskToTarget(page, retryCard, taskCardSurface(releaseChecklistCard), 0.8);
  const retryCardInQa = qaColumn.getByTestId("task-card-task-1");
  await expect(retryCardInQa).toBeVisible();
  await beginTaskDrag(page, retryCardInQa);
  await hoverDraggedTaskToNestTarget(page, createdCard, 0.35, shipNoteSubtaskSlot);
  await finishTaskDrag(page);
  await expect(createdCard.locator(".task-card__subtasks").getByText("Review retry settings")).toBeVisible();
  await expect(todoColumn.getByText("Review retry settings")).toHaveCount(0);

  const retrySubtask = createdCard.locator(".task-card__subtasks").getByTestId("task-card-task-1");
  await beginTaskDrag(page, retrySubtask);
  await hoverDraggedTaskOver(page, qaContent, 0.95);
  await finishTaskDrag(page);
  await expect(createdCard.locator(".task-card__subtasks").getByText("Review retry settings")).toHaveCount(0);
  await expect(qaColumn.getByText("Review retry settings")).toBeVisible();

  await beginTaskDrag(page, copyCard);
  await hoverDraggedTaskOver(page, qaContent, 0.95);
  await finishTaskDrag(page);
  const copyCardInQa = qaColumn.getByTestId("task-card-task-4");
  await expect(copyCardInQa).toBeVisible();
  await beginTaskDrag(page, copyCardInQa);
  await hoverDraggedTaskToNestTarget(page, createdCard, 0.5, shipNoteSubtaskSlot);
  await finishTaskDrag(page);
  await expect(createdCard.locator(".task-card__subtasks").getByText("Queue copy pass")).toBeVisible();
  await expect(todoColumn.getByText("Queue copy pass")).toHaveCount(0);

  const nestedCopyCard = createdCard.locator(".task-card__subtasks").getByTestId("task-card-task-4");
  await beginTaskDrag(page, taskCardSurface(createdCard));
  await hoverDraggedTaskOver(page, taskCardSurface(nestedCopyCard));
  await expect(createdCard).not.toHaveClass(/is-nest-target/);
  await expect(nestedCopyCard).not.toHaveClass(/task-card--drop-before/);
  await expect(nestedCopyCard).not.toHaveClass(/task-card--drop-after/);
  await finishTaskDrag(page);
  await expect(page.getByText("Subtasks can only be added under top-level tasks.")).toHaveCount(0);
  await expect(createdCard).toBeVisible();
  await expect(createdCard.locator(".task-card__subtasks").getByText("Queue copy pass")).toBeVisible();

  const qaLaneDeleteButton = page.getByLabel("Delete lane Ready for QA");
  await qaLaneDeleteButton.click();
  const laneDeleteDialog = page.getByRole("alertdialog", { name: "Delete lane Ready for QA" });
  await expect(laneDeleteDialog).toBeVisible();
  await expect(laneDeleteDialog.getByLabel("Move tasks from Ready for QA to")).toBeVisible();
  await laneDeleteDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: "Ready for QA" })).toBeVisible();

  await qaLaneDeleteButton.click();
  await laneDeleteDialog.getByLabel("Move tasks from Ready for QA to").selectOption(laneId("project-1", "done"));
  await laneDeleteDialog.getByRole("button", { exact: true, name: "Delete" }).click();
  await expect(page.getByRole("heading", { name: "Ready for QA" })).toHaveCount(0);
  const createdCardInDone = doneColumn.getByTestId("task-card-task-5");
  await expect(createdCardInDone).toBeVisible();
  await expect(createdCardInDone.locator(".task-card__subtasks").getByText("Queue copy pass")).toBeVisible();
  await expect(doneColumn.getByText("Review retry settings")).toBeVisible();
  const laneDeleteToast = page.getByTestId("toast-notice");
  await expect(laneDeleteToast).toBeVisible();
  await expect(laneDeleteToast).toContainText("Lane deleted");
  await expect(laneDeleteToast).toContainText("Ready for QA was deleted. Cards moved to Done.");
});

test("board page previews a dragged task at the top of Done before drop", async ({ page }) => {
  const tasksWithDoneCards = structuredClone(tasks);

  tasksWithDoneCards.push(
    {
      body: "",
      createdAt: "2026-03-18T07:00:00.000Z",
      id: "task-5",
      laneId: laneId("project-1", "done"),
      parentTaskId: null,
      position: 2,
      projectId: "project-1",
      ticketId: "BILL-5",
      tags: [],
      title: "Archive roadmap",
      updatedAt: "2026-03-18T07:40:00.000Z"
    }
  );

  await mockAuthenticated(page, {
    projects: projectsForGrid,
    tasks: tasksWithDoneCards
  });

  await page.goto(billingBoardPath);

  const doneColumn = page.getByTestId(`board-column-${laneId("project-1", "done")}`);
  const callbackLoggingCard = page.getByTestId("task-card-task-2");
  const doneTopInsertSlot = page.getByTestId(`task-drop-slot-${laneId("project-1", "done")}-0`);
  const archivedRoadmapCard = page.getByTestId("task-card-task-5");
  const healthcheckLoopCard = page.getByTestId("task-card-task-3");

  await expect(doneColumn.locator(".task-card__title")).toHaveText([
    "[BILL-3] Remove healthcheck loop",
    "[BILL-5] Archive roadmap"
  ]);

  await beginTaskDrag(page, taskCardSurface(callbackLoggingCard));
  await hoverDraggedTaskOver(page, taskCardSurface(archivedRoadmapCard), 0.2);

  await expect(doneTopInsertSlot).toHaveClass(/is-active/);
  await expect(healthcheckLoopCard).toHaveClass(/task-card--drop-before/);
  await expect(healthcheckLoopCard).toHaveClass(/task-card--shift-down/);

  await expect(doneColumn.locator(".task-card__title")).toHaveText([
    "[BILL-3] Remove healthcheck loop",
    "[BILL-5] Archive roadmap"
  ]);

  await finishTaskDrag(page);

  await expect(doneColumn.locator(".task-card__title")).toHaveText([
    "[BILL-2] Tighten callback logging",
    "[BILL-3] Remove healthcheck loop",
    "[BILL-5] Archive roadmap"
  ]);
});

test("board page keeps Done ordered by newest update time and ignores drag reordering", async ({ page }) => {
  const tasksWithDoneCards = structuredClone(tasks);

  tasksWithDoneCards.push(
    {
      body: "",
      createdAt: "2026-03-18T07:00:00.000Z",
      id: "task-5",
      laneId: laneId("project-1", "done"),
      parentTaskId: null,
      position: 2,
      projectId: "project-1",
      ticketId: "BILL-5",
      tags: [],
      title: "Archive roadmap",
      updatedAt: "2026-03-18T07:40:00.000Z"
    },
    {
      body: "",
      createdAt: "2026-03-18T07:10:00.000Z",
      id: "task-6",
      laneId: laneId("project-1", "done"),
      parentTaskId: null,
      position: 1,
      projectId: "project-1",
      ticketId: "BILL-6",
      tags: [],
      title: "Ship docs",
      updatedAt: "2026-03-18T08:10:00.000Z"
    }
  );

  await mockAuthenticated(page, {
    projects: projectsForGrid,
    tasks: tasksWithDoneCards
  });

  await page.goto(billingBoardPath);

  const doneColumn = page.getByTestId(`board-column-${laneId("project-1", "done")}`);
  const archivedRoadmapCard = page.getByTestId("task-card-task-5");
  const shippedDocsCard = page.getByTestId("task-card-task-6");

  await expect(doneColumn.locator(".task-card__title")).toHaveText([
    "[BILL-6] Ship docs",
    "[BILL-3] Remove healthcheck loop",
    "[BILL-5] Archive roadmap"
  ]);

  await dragTaskToTarget(page, taskCardSurface(shippedDocsCard), taskCardSurface(archivedRoadmapCard), 0.2);

  await expect(doneColumn.locator(".task-card__title")).toHaveText([
    "[BILL-6] Ship docs",
    "[BILL-3] Remove healthcheck loop",
    "[BILL-5] Archive roadmap"
  ]);
});

test("board page previews nesting under a top-level card before drop", async ({ page }) => {
  const projectsWithQaLane = structuredClone(projectsForGrid);
  const tasksWithQaCards = structuredClone(tasks);
  const billingCleanupProject = projectsWithQaLane.find((project) => project.id === "project-1");
  if (!billingCleanupProject) {
    throw new Error("Expected project-1 test fixture to exist");
  }

  billingCleanupProject.laneSummaries.push({
    createdAt: "2026-03-18T08:00:00.000Z",
    id: "project-1-lane-custom-1",
    name: "Ready for QA",
    position: 4,
    projectId: "project-1",
    taskCount: 0,
    updatedAt: "2026-03-18T08:00:00.000Z"
  });

  tasksWithQaCards.push(
    {
      body: "",
      createdAt: "2026-03-18T08:00:00.000Z",
      id: "task-5",
      laneId: "project-1-lane-custom-1",
      parentTaskId: null,
      position: 0,
      projectId: "project-1",
      ticketId: "BILL-5",
      tags: [],
      title: "Ship note",
      updatedAt: "2026-03-18T08:00:00.000Z"
    },
    {
      body: "",
      createdAt: "2026-03-18T08:05:00.000Z",
      id: "task-6",
      laneId: "project-1-lane-custom-1",
      parentTaskId: null,
      position: 1,
      projectId: "project-1",
      ticketId: "BILL-6",
      tags: [],
      title: "Release checklist",
      updatedAt: "2026-03-18T08:05:00.000Z"
    }
  );

  await mockAuthenticated(page, {
    projects: projectsWithQaLane,
    tasks: tasksWithQaCards
  });

  await page.goto(billingBoardPath);

  const qaColumn = page.getByTestId("board-column-project-1-lane-custom-1");
  const shipNoteCard = page.getByTestId("task-card-task-5");
  const copyCard = page.getByTestId("task-card-task-4");
  const qaRootInsertSlot = page.getByTestId("task-drop-slot-project-1-lane-custom-1-2");
  const shipNoteSubtaskSlot = page.getByTestId("task-drop-slot-task-5-0");

  await dragTaskToTarget(page, copyCard, qaRootInsertSlot);
  const copyCardInQa = qaColumn.getByTestId("task-card-task-4");
  await expect(copyCardInQa).toBeVisible();

  await beginTaskDrag(page, copyCardInQa);
  await hoverDraggedTaskToNestTarget(page, shipNoteCard, 0.35, shipNoteSubtaskSlot);

  await expect(shipNoteCard).toHaveClass(/is-nest-target/);
  await expect(shipNoteSubtaskSlot).toHaveClass(/is-active/);

  await finishTaskDrag(page);
  await expect(shipNoteCard.locator(".task-card__subtasks").getByText("Queue copy pass")).toBeVisible();
});

test("board page previews un-nesting a subtask back to the root group", async ({ page }) => {
  const projectsWithQaLane = structuredClone(projectsForGrid);
  const tasksWithQaCard = structuredClone(tasks);
  const billingCleanupProject = projectsWithQaLane.find((project) => project.id === "project-1");
  if (!billingCleanupProject) {
    throw new Error("Expected project-1 test fixture to exist");
  }

  billingCleanupProject.laneSummaries.push({
    createdAt: "2026-03-18T08:00:00.000Z",
    id: "project-1-lane-custom-1",
    name: "Ready for QA",
    position: 4,
    projectId: "project-1",
    taskCount: 0,
    updatedAt: "2026-03-18T08:00:00.000Z"
  });

  const retryTask = tasksWithQaCard.find((task) => task.id === "task-1");
  if (!retryTask) {
    throw new Error("Expected task-1 test fixture to exist");
  }

  retryTask.laneId = "project-1-lane-custom-1";
  retryTask.parentTaskId = "task-5";
  retryTask.position = 0;

  tasksWithQaCard.push(
    {
      body: "",
      createdAt: "2026-03-18T08:00:00.000Z",
      id: "task-5",
      laneId: "project-1-lane-custom-1",
      parentTaskId: null,
      position: 0,
      projectId: "project-1",
      ticketId: "BILL-5",
      tags: [],
      title: "Ship note",
      updatedAt: "2026-03-18T08:00:00.000Z"
    },
    {
      body: "",
      createdAt: "2026-03-18T08:05:00.000Z",
      id: "task-6",
      laneId: "project-1-lane-custom-1",
      parentTaskId: null,
      position: 1,
      projectId: "project-1",
      ticketId: "BILL-6",
      tags: [],
      title: "Release checklist",
      updatedAt: "2026-03-18T08:05:00.000Z"
    }
  );

  await mockAuthenticated(page, {
    projects: projectsWithQaLane,
    tasks: tasksWithQaCard
  });

  await page.goto(billingBoardPath);

  const qaColumn = page.getByTestId("board-column-project-1-lane-custom-1");
  const qaContent = qaColumn.locator(".board-column__content");
  const shipNoteCard = page.getByTestId("task-card-task-5");
  const retrySubtask = shipNoteCard.locator(".task-card__subtasks").getByTestId("task-card-task-1");
  const qaRootAfterReleaseSlot = page.getByTestId("task-drop-slot-project-1-lane-custom-1-2");

  await beginTaskDrag(page, retrySubtask);
  await hoverDraggedTaskOver(page, qaContent, 0.95);

  await expect(qaRootAfterReleaseSlot).toHaveClass(/is-active/);

  await finishTaskDrag(page);
  await expect(shipNoteCard.locator(".task-card__subtasks").getByText("Review retry settings")).toHaveCount(0);
  await expect(qaColumn.getByText("Review retry settings")).toBeVisible();
});

test("board page moves a dragged subtask under another empty parent", async ({ page }) => {
  const projectsWithQaLane = structuredClone(projectsForGrid);
  const tasksWithQaCards = structuredClone(tasks);
  const billingCleanupProject = projectsWithQaLane.find((project) => project.id === "project-1");
  if (!billingCleanupProject) {
    throw new Error("Expected project-1 test fixture to exist");
  }

  billingCleanupProject.laneSummaries.push({
    createdAt: "2026-03-18T08:00:00.000Z",
    id: "project-1-lane-custom-1",
    name: "Ready for QA",
    position: 4,
    projectId: "project-1",
    taskCount: 0,
    updatedAt: "2026-03-18T08:00:00.000Z"
  });

  tasksWithQaCards.push(
    {
      body: "",
      createdAt: "2026-03-18T08:00:00.000Z",
      id: "task-5",
      laneId: "project-1-lane-custom-1",
      parentTaskId: null,
      position: 0,
      projectId: "project-1",
      ticketId: "BILL-5",
      tags: [],
      title: "Ship note",
      updatedAt: "2026-03-18T08:00:00.000Z"
    },
    {
      body: "",
      createdAt: "2026-03-18T08:05:00.000Z",
      id: "task-6",
      laneId: "project-1-lane-custom-1",
      parentTaskId: null,
      position: 1,
      projectId: "project-1",
      ticketId: "BILL-6",
      tags: [],
      title: "Release checklist",
      updatedAt: "2026-03-18T08:05:00.000Z"
    }
  );

  await mockAuthenticated(page, {
    projects: projectsWithQaLane,
    tasks: tasksWithQaCards
  });

  await page.goto(billingBoardPath);

  const shipNoteCard = page.getByTestId("task-card-task-5");
  const releaseChecklistCard = page.getByTestId("task-card-task-6");
  const copyCard = page.getByTestId("task-card-task-4");
  const qaRootInsertSlot = page.getByTestId("task-drop-slot-project-1-lane-custom-1-2");
  const shipNoteSubtaskSlot = page.getByTestId("task-drop-slot-task-5-0");
  const releaseChecklistSubtaskSlot = page.getByTestId("task-drop-slot-task-6-0");

  await dragTaskToTarget(page, copyCard, qaRootInsertSlot);
  const copyCardInQa = page.getByTestId("task-card-task-4");
  await expect(copyCardInQa).toBeVisible();
  await beginTaskDrag(page, copyCardInQa);
  await hoverDraggedTaskToNestTarget(page, shipNoteCard, 0.35, shipNoteSubtaskSlot);
  await finishTaskDrag(page);
  await expect(shipNoteCard.locator(".task-card__subtasks").getByText("Queue copy pass")).toBeVisible();

  const copySubtask = shipNoteCard.locator(".task-card__subtasks").getByTestId("task-card-task-4");
  await beginTaskDrag(page, copySubtask);
  await hoverDraggedTaskToNestTarget(page, releaseChecklistCard, 0.5, releaseChecklistSubtaskSlot);
  await finishTaskDrag(page);

  await expect(shipNoteCard.locator(".task-card__subtasks").getByText("Queue copy pass")).toHaveCount(0);
  await expect(releaseChecklistCard.locator(".task-card__subtasks").getByText("Queue copy pass")).toBeVisible();
});

test("board page keeps subtask drags inside the parent group", async ({ page }) => {
  const projectsWithQaLane = structuredClone(projectsForGrid);
  const tasksWithQaCard = structuredClone(tasks);
  const billingCleanupProject = projectsWithQaLane.find((project) => project.id === "project-1");
  if (!billingCleanupProject) {
    throw new Error("Expected project-1 test fixture to exist");
  }

  billingCleanupProject.laneSummaries.push({
    createdAt: "2026-03-18T08:00:00.000Z",
    id: "project-1-lane-custom-1",
    name: "Ready for QA",
    position: 4,
    projectId: "project-1",
    taskCount: 0,
    updatedAt: "2026-03-18T08:00:00.000Z"
  });

  const retryTask = tasksWithQaCard.find((task) => task.id === "task-1");
  const copyTask = tasksWithQaCard.find((task) => task.id === "task-4");
  if (!retryTask || !copyTask) {
    throw new Error("Expected task-1 and task-4 test fixtures to exist");
  }

  retryTask.laneId = "project-1-lane-custom-1";
  retryTask.parentTaskId = "task-5";
  retryTask.position = 0;
  copyTask.laneId = "project-1-lane-custom-1";
  copyTask.parentTaskId = "task-5";
  copyTask.position = 1;

  tasksWithQaCard.push({
    body: "",
    createdAt: "2026-03-18T08:00:00.000Z",
    id: "task-5",
    laneId: "project-1-lane-custom-1",
    parentTaskId: null,
    position: 0,
    projectId: "project-1",
    ticketId: "BILL-5",
    tags: [],
    title: "Ship note",
    updatedAt: "2026-03-18T08:00:00.000Z"
  });

  await mockAuthenticated(page, {
    projects: projectsWithQaLane,
    tasks: tasksWithQaCard
  });

  await page.goto(billingBoardPath);

  const shipNoteCard = page.getByTestId("task-card-task-5");
  const retrySubtask = shipNoteCard.locator(".task-card__subtasks").getByTestId("task-card-task-1");
  const copySubtask = shipNoteCard.locator(".task-card__subtasks").getByTestId("task-card-task-4");
  await dragTaskToTarget(page, copySubtask, taskCardSurface(retrySubtask), 0.2);

  await expect(shipNoteCard.locator(".task-card__subtasks .task-card--subtask")).toHaveCount(2);
  await expect(shipNoteCard.locator(".task-card__subtasks").getByText("Review retry settings")).toBeVisible();
  await expect(shipNoteCard.locator(".task-card__subtasks").getByText("Queue copy pass")).toBeVisible();
});

test("board page resets a subtask preview when dragged back over its current parent", async ({ page }) => {
  const projectsWithQaLane = structuredClone(projectsForGrid);
  const tasksWithQaCards = structuredClone(tasks);
  const billingCleanupProject = projectsWithQaLane.find((project) => project.id === "project-1");
  if (!billingCleanupProject) {
    throw new Error("Expected project-1 test fixture to exist");
  }

  billingCleanupProject.laneSummaries.push({
    createdAt: "2026-03-18T08:00:00.000Z",
    id: "project-1-lane-custom-1",
    name: "Ready for QA",
    position: 4,
    projectId: "project-1",
    taskCount: 0,
    updatedAt: "2026-03-18T08:00:00.000Z"
  });

  const copyTask = tasksWithQaCards.find((task) => task.id === "task-4");
  if (!copyTask) {
    throw new Error("Expected task-4 test fixture to exist");
  }

  copyTask.laneId = "project-1-lane-custom-1";
  copyTask.parentTaskId = "task-5";
  copyTask.position = 0;

  tasksWithQaCards.push(
    {
      body: "",
      createdAt: "2026-03-18T08:00:00.000Z",
      id: "task-5",
      laneId: "project-1-lane-custom-1",
      parentTaskId: null,
      position: 0,
      projectId: "project-1",
      ticketId: "BILL-5",
      tags: [],
      title: "Ship note",
      updatedAt: "2026-03-18T08:00:00.000Z"
    },
    {
      body: "",
      createdAt: "2026-03-18T08:05:00.000Z",
      id: "task-6",
      laneId: "project-1-lane-custom-1",
      parentTaskId: null,
      position: 1,
      projectId: "project-1",
      ticketId: "BILL-6",
      tags: [],
      title: "Release checklist",
      updatedAt: "2026-03-18T08:05:00.000Z"
    }
  );

  await mockAuthenticated(page, {
    projects: projectsWithQaLane,
    tasks: tasksWithQaCards
  });

  await page.goto(billingBoardPath);

  const shipNoteCard = page.getByTestId("task-card-task-5");
  const releaseChecklistCard = page.getByTestId("task-card-task-6");
  const copySubtask = shipNoteCard.locator(".task-card__subtasks").getByTestId("task-card-task-4");
  const shipNoteSubtaskSlot = page.getByTestId("task-drop-slot-task-5-0");

  await beginTaskDrag(page, copySubtask);
  await hoverDraggedTaskDirectlyToTarget(page, taskCardSurface(releaseChecklistCard), 0.5);

  await hoverDraggedTaskToNestTarget(page, shipNoteCard, 0.35, shipNoteSubtaskSlot);
  await expect(shipNoteCard.locator(".task-card__subtasks").getByText("Queue copy pass")).toBeVisible();

  await finishTaskDrag(page);
  await expect(shipNoteCard.locator(".task-card__subtasks").getByText("Queue copy pass")).toBeVisible();
  await expect(releaseChecklistCard.locator(".task-card__subtasks").getByText("Queue copy pass")).toHaveCount(0);
});

test("board page adds tasks from the lane header action and keeps the double-click shortcut", async ({ page }) => {
  const todoLaneId = laneId("project-1", "todo");

  await mockAuthenticated(page, { projects: projectsForGrid });

  await page.goto(billingBoardPath);

  const addTaskButton = page.getByTestId(`add-task-button-${todoLaneId}`);
  const composer = page.getByTestId(`lane-composer-${todoLaneId}`);

  await expect(addTaskButton).toBeVisible();
  const addTaskButtonBorderWidth = await addTaskButton.evaluate(
    (element) => window.getComputedStyle(element).borderTopWidth
  );
  expect(addTaskButtonBorderWidth).toBe("0px");
  await addTaskButton.click();
  await expect(composer).toBeVisible();

  const composerInput = composer.getByLabel("New task title for Todo");
  await composerInput.fill("Capture mobile tap flow");
  await composerInput.press("Enter");

  await expect(page.locator(".task-card__title", { hasText: "Capture mobile tap flow" })).toBeVisible();

  await page.getByTestId(`lane-header-${todoLaneId}`).dblclick({ position: { x: 28, y: 18 } });
  await expect(composer).toBeVisible();
  await composer.getByRole("button", { name: "Cancel" }).click();
  await expect(composer).toHaveCount(0);
});

test("board page clears the search query after adding a task from a filtered board", async ({ page }) => {
  const todoLaneId = laneId("project-1", "todo");

  await mockAuthenticated(page, { projects: projectsForGrid });

  await page.goto(`${billingBoardPath}?q=callback&tags=ops`);

  const addTaskButton = page.getByTestId(`add-task-button-${todoLaneId}`);
  const composer = page.getByTestId(`lane-composer-${todoLaneId}`);

  await expect(page.getByLabel("Search cards")).toHaveValue("callback");
  await expect(page.getByLabel("Remove tag filter ops")).toBeVisible();
  await expect(page.locator(".task-card__title", { hasText: "Clear stale search state" })).toHaveCount(0);

  await addTaskButton.click();
  await expect(composer).toBeVisible();

  const composerInput = composer.getByLabel("New task title for Todo");
  await composerInput.fill("Clear stale search state");
  await composerInput.press("Enter");

  await expect(page).toHaveURL(/\/projects\/BILL$/);
  await expect(page.getByLabel("Search cards")).toHaveValue("");
  await expect(page.getByLabel("Remove tag filter ops")).toHaveCount(0);
  await expect(page.locator(".task-card__title", { hasText: "Clear stale search state" })).toBeVisible();
});

test("board page shows a pointer cursor on task cards when filters disable dragging", async ({ page }) => {
  await mockAuthenticated(page, { projects: projectsForGrid });

  await page.goto(`${billingBoardPath}?q=callback`);

  await expect(page.getByTestId("task-card-task-2").locator(".task-card__surface")).toHaveCSS("cursor", "pointer");
});

test("board page creates lanes from the gap between columns", async ({ page }) => {
  await mockAuthenticated(page, { projects: projectsForGrid });

  await page.goto(billingBoardPath);

  await expect(page.getByRole("button", { exact: true, name: "Create Lane" })).toHaveCount(0);

  const createLaneGap = page.getByTestId(`create-lane-gap-after-${laneId("project-1", "todo")}`);
  await expect(createLaneGap).toBeVisible();
  const gapDividerContent = await createLaneGap.evaluate((element) =>
    window.getComputedStyle(element, "::before").content.replaceAll('"', "")
  );
  expect(["none", "normal"]).toContain(gapDividerContent);
  await createLaneGap.dblclick();

  const laneDialog = page.getByRole("dialog", { name: "Create Lane" });
  await expect(laneDialog).toBeVisible();
  await expect(laneDialog.locator(".field__label", { hasText: "Lane name" })).toHaveCount(0);
  await laneDialog.getByLabel("Lane name").fill("Ready for QA");
  await laneDialog.getByRole("button", { exact: true, name: "Create Lane" }).click();

  await expect(page.locator(".board-column__header h2")).toHaveText([
    "Todo",
    "In Progress",
    "In review",
    "Done",
    "Ready for QA"
  ]);
});

test("board page keeps a tall lane gap marker in the first screen", async ({ page }) => {
  const projectsWithTallTodo = structuredClone(projectsForGrid);
  const tasksWithTallTodo = structuredClone(tasks);
  const billingCleanupProject = projectsWithTallTodo.find((project) => project.id === "project-1");
  if (!billingCleanupProject) {
    throw new Error("Expected project-1 test fixture to exist");
  }

  const todoLaneSummary = billingCleanupProject.laneSummaries.find(
    (laneSummary) => laneSummary.id === laneId("project-1", "todo")
  );
  if (!todoLaneSummary) {
    throw new Error("Expected the Todo lane summary to exist");
  }

  for (let taskIndex = 0; taskIndex < 18; taskIndex += 1) {
    tasksWithTallTodo.push({
      body: "",
      createdAt: `2026-03-18T09:${String(taskIndex).padStart(2, "0")}:00.000Z`,
      id: `task-tall-${taskIndex + 1}`,
      laneId: laneId("project-1", "todo"),
      parentTaskId: null,
      position: tasks.length + taskIndex,
      projectId: "project-1",
      ticketId: `BILL-${taskIndex + 10}`,
      tags: [],
      title: `Tall backlog ${taskIndex + 1}`,
      updatedAt: `2026-03-18T09:${String(taskIndex).padStart(2, "0")}:30.000Z`
    });
  }

  todoLaneSummary.taskCount = tasksWithTallTodo.filter(
    (task) => task.projectId === "project-1" && task.laneId === laneId("project-1", "todo")
  ).length;

  await mockAuthenticated(page, {
    projects: projectsWithTallTodo,
    tasks: tasksWithTallTodo
  });

  await page.goto(billingBoardPath);

  const createLaneGap = page.getByTestId(`create-lane-gap-after-${laneId("project-1", "todo")}`);
  const createLaneGapMarker = createLaneGap.locator(".board-lane-gap__marker");
  await createLaneGap.hover({ position: { x: 4, y: 16 } });
  await expect(createLaneGapMarker).toBeVisible();

  const gapBox = await createLaneGap.boundingBox();
  const markerBox = await createLaneGapMarker.boundingBox();
  const viewportHeight = page.viewportSize()?.height ?? 0;

  expect(gapBox).not.toBeNull();
  expect(markerBox).not.toBeNull();
  expect(viewportHeight).toBeGreaterThan(0);

  const gapHeight = gapBox?.height ?? 0;
  const markerCenterY = (markerBox?.y ?? 0) + (markerBox?.height ?? 0) / 2;
  const expectedMarkerCenterY = (gapBox?.y ?? 0) + Math.min(gapHeight / 2, viewportHeight / 2);

  expect(gapHeight).toBeGreaterThan(viewportHeight);
  expect(Math.abs(markerCenterY - expectedMarkerCenterY)).toBeLessThanOrEqual(12);
});

test.describe("mobile board page", () => {
  test.use({
    ...iPhone13
  });

  test("board page opens a task from a single mobile tap", async ({ page }) => {
    await mockAuthenticated(page, { projects: projectsForGrid });

    await page.goto(billingBoardPath);

    const firstTaskCard = page.getByTestId("task-card-task-1");

    await tapLocatorWithTouch(page, taskCardTitle(firstTaskCard));

    await expect(page).toHaveURL(/\/projects\/BILL\/BILL-1$/);
    await expect(page.getByRole("dialog", { name: "Edit BILL-1" })).toBeVisible();
  });

  test("board page expands task details to the full mobile viewport", async ({ page }) => {
    await mockAuthenticated(page, { projects: projectsForGrid });

    await page.goto(billingBoardPath);

    const firstTaskCard = page.getByTestId("task-card-task-1");

    await tapLocatorWithTouch(page, taskCardTitle(firstTaskCard));

    const editDialog = page.getByRole("dialog", { name: "Edit BILL-1" });
    const dialogPanel = page.locator(".dialog-panel--task-editor");
    const fullscreenButton = editDialog.getByRole("button", { name: "Enter full screen" });
    const closeButton = editDialog.getByLabel("Close edit task dialog");
    const viewport = page.viewportSize();

    await expect(editDialog).toBeVisible();

    const initialDialogBox = await dialogPanel.boundingBox();
    expect(initialDialogBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect((initialDialogBox?.x ?? 0)).toBeGreaterThan(8);
    expect((initialDialogBox?.y ?? 0)).toBeGreaterThan(8);

    await fullscreenButton.tap();

    await expect(editDialog.getByRole("button", { name: "Exit full screen" })).toBeVisible();

    const fullscreenDialogBox = await dialogPanel.boundingBox();
    expect(fullscreenDialogBox).not.toBeNull();
    expect((fullscreenDialogBox?.x ?? 0)).toBeLessThanOrEqual(1);
    expect((fullscreenDialogBox?.y ?? 0)).toBeLessThanOrEqual(1);
    expect((fullscreenDialogBox?.width ?? 0)).toBeGreaterThan((initialDialogBox?.width ?? 0) + 20);
    expect((fullscreenDialogBox?.height ?? 0)).toBeGreaterThan((initialDialogBox?.height ?? 0) + 20);
    expect((fullscreenDialogBox?.width ?? 0)).toBeGreaterThanOrEqual((viewport?.width ?? 0) - 1);
    expect((fullscreenDialogBox?.height ?? 0)).toBeGreaterThanOrEqual((viewport?.height ?? 0) - 1);

    await closeButton.tap();
    await expect(editDialog).toHaveCount(0);
  });

  test("board page keeps footer metadata below the editor in mobile fullscreen", async ({ page }) => {
    const mobileTasks = structuredClone(tasks);
    const longBodyTask = mobileTasks.find((task) => task.id === "task-1");

    if (!longBodyTask) {
      throw new Error("Expected task-1 fixture to exist");
    }

    longBodyTask.body = Array.from({ length: 24 }, (_, index) => `- Mobile fullscreen note ${index + 1}`).join("\n");

    await mockAuthenticated(page, {
      projects: projectsForGrid,
      tasks: mobileTasks
    });

    await page.goto(billingBoardPath);

    await tapLocatorWithTouch(page, taskCardTitle(page.getByTestId("task-card-task-1")));

    const editDialog = page.getByRole("dialog", { name: "Edit BILL-1" });
    const fullscreenButton = editDialog.getByRole("button", { name: "Enter full screen" });
    const bodyField = editDialog.locator(".field--editor");
    const bodyPanel = editDialog.locator(".task-editor__panel");
    const bodyTextarea = editDialog.getByLabel("Task body");
    const footerMeta = editDialog.locator(".task-editor__meta--footer");

    await expect(editDialog).toBeVisible();
    await fullscreenButton.tap();
    await expect(editDialog.getByRole("button", { name: "Exit full screen" })).toBeVisible();
    await expect(bodyPanel).toBeVisible();
    await expect(bodyTextarea).toBeVisible();
    await expect(footerMeta).toBeVisible();

    const bodyFieldBox = await bodyField.boundingBox();
    const bodyPanelBox = await bodyPanel.boundingBox();
    const footerMetaBox = await footerMeta.boundingBox();

    expect(bodyFieldBox).not.toBeNull();
    expect(bodyPanelBox).not.toBeNull();
    expect(footerMetaBox).not.toBeNull();
    const bodyPanelBottom = bodyPanelBox!.y + bodyPanelBox!.height;
    const bodyFieldBottom = bodyFieldBox!.y + bodyFieldBox!.height;

    expect(bodyPanelBottom).toBeLessThanOrEqual(bodyFieldBottom + 1);
    expect(bodyFieldBottom).toBeLessThanOrEqual(footerMetaBox!.y + 1);
  });

  test("board page uses compact task editor controls on small screens", async ({ page }) => {
    const mobileTasks = structuredClone(tasks);
    const compactTask = mobileTasks.find((task) => task.id === "task-1");

    if (!compactTask) {
      throw new Error("Expected task-1 fixture to exist");
    }

    compactTask.body = "";
    compactTask.tags = [];
    compactTask.title = "Compact mobile edit";

    await mockAuthenticated(page, {
      projects: projectsForGrid,
      tasks: mobileTasks
    });

    await page.goto(billingBoardPath);

    await tapLocatorWithTouch(page, taskCardTitle(page.getByTestId("task-card-task-1")));

    const editDialog = page.getByRole("dialog", { name: "Edit BILL-1" });
    const fullscreenButton = editDialog.getByRole("button", { name: "Enter full screen" });
    const previewTab = editDialog.getByRole("tab", { name: "Rendered preview" });
    const titleInput = editDialog.getByLabel("Title");
    const tagInputShell = editDialog.locator(".task-tag-editor__input-shell");

    await expect(editDialog).toBeVisible();
    await fullscreenButton.tap();
    await previewTab.tap();
    await expect(editDialog.getByRole("button", { name: "Exit full screen" })).toBeVisible();

    const titleInputBox = await titleInput.boundingBox();
    const tagInputShellBox = await tagInputShell.boundingBox();

    expect(titleInputBox).not.toBeNull();
    expect(tagInputShellBox).not.toBeNull();
    expect(titleInputBox!.height).toBeLessThanOrEqual(48);
    expect(tagInputShellBox!.height).toBeLessThanOrEqual(48);
    await expect(previewTab).toHaveCSS("width", "36px");
    await expect(previewTab).toHaveCSS("height", "36px");
  });

  test("board page moves a task between lanes with a mobile long press drag", async ({ page }) => {
    const mobileProjects = structuredClone(projectsForGrid);
    const mobileTasks = structuredClone(tasks).filter(
      (task) => task.id === "task-1" || task.id === "task-2"
    );
    const billingCleanupProject = mobileProjects.find((project) => project.id === "project-1");
    if (!billingCleanupProject) {
      throw new Error("Expected project-1 test fixture to exist");
    }

    billingCleanupProject.laneSummaries = billingCleanupProject.laneSummaries.map((laneSummary) => ({
      ...laneSummary,
      taskCount:
        laneSummary.id === laneId("project-1", "todo")
          ? 1
          : laneSummary.id === laneId("project-1", "in_progress")
            ? 1
            : 0
    }));

    await mockAuthenticated(page, {
      projects: mobileProjects,
      tasks: mobileTasks
    });

    await page.goto(billingBoardPath);

    const todoLaneId = laneId("project-1", "todo");
    const inProgressLaneId = laneId("project-1", "in_progress");
    const todoColumn = page.getByTestId(`board-column-${todoLaneId}`);
    const inProgressColumn = page.getByTestId(`board-column-${inProgressLaneId}`);
    const sourceCard = todoColumn.getByTestId("task-card-task-1");
    const targetRootSlot = page.getByTestId(`task-drop-slot-${inProgressLaneId}-0`);
    const moveTaskResponse = page.waitForResponse((response) =>
      requestMatchesTaskUpdate(response.request(), "project-1", "task-1", {
        laneId: inProgressLaneId,
        parentTaskId: null,
        position: 0
      })
    );

    // Use Chromium touch events here so the test exercises the real mobile long-press path.
    await dragTaskWithTouch(page, taskCardSurface(sourceCard), targetRootSlot);
    await moveTaskResponse;

    await expect(page).toHaveURL(/\/projects\/BILL$/);
    await expect(page.getByRole("dialog", { name: /Edit BILL-/ })).toHaveCount(0);
    await expect(todoColumn.getByTestId("task-card-task-1")).toHaveCount(0, { timeout: 15000 });
    await expect(inProgressColumn.getByTestId("task-card-task-1")).toBeVisible();
    await expect(inProgressColumn.locator(".task-card__title")).toHaveText([
      "[BILL-1] Review retry settings",
      "[BILL-2] Tighten callback logging"
    ]);
  });

  test("board page deletes tasks from the floating mobile trash dock", async ({ page }) => {
    const todoLaneId = laneId("project-1", "todo");

    await mockAuthenticated(page, {
      projects: projectsForGrid,
      tasks
    });

    await page.goto(billingBoardPath);

    const sourceCard = page.getByTestId("task-card-task-1");
    const mobileTrashTarget = page.getByTestId("mobile-task-trash-target");
    const headerTrashTarget = page.getByTestId(`lane-task-trash-target-${todoLaneId}`);
    const deleteDialog = page.getByRole("alertdialog", { name: "Delete task Review retry settings" });

    await expect(mobileTrashTarget).toHaveCount(0);
    await expect(headerTrashTarget).toBeHidden();

    await dragTaskWithTouch(page, taskCardSurface(sourceCard), mobileTrashTarget);

    await expect(deleteDialog).toBeVisible();
    await deleteDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(sourceCard).toBeVisible();
    await expect(mobileTrashTarget).toHaveCount(0);
    await expect(headerTrashTarget).toBeHidden();

    await dragTaskWithTouch(page, taskCardSurface(sourceCard), mobileTrashTarget);

    await expect(deleteDialog).toBeVisible();
    await confirmTaskDelete(page, deleteDialog, "project-1", "task-1");
    const taskDeleteToast = page.getByTestId("toast-notice");
    await expect(taskDeleteToast).toBeVisible();
    await expect(taskDeleteToast).toContainText("Task deleted");
    await expect(taskDeleteToast).toContainText("Review retry settings (BILL-1) was deleted.");
    await expect(sourceCard).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByTestId("task-card-task-4")).toBeVisible();
    await expect(mobileTrashTarget).toHaveCount(0);
  });

  test("board page deletes a scrolled mobile task with the floating trash dock", async ({ page }) => {
    const projectsWithTallTodo = structuredClone(projectsForGrid);
    const tasksWithTallTodo = structuredClone(tasks);
    const billingCleanupProject = projectsWithTallTodo.find((project) => project.id === "project-1");
    if (!billingCleanupProject) {
      throw new Error("Expected project-1 test fixture to exist");
    }

    const todoLaneSummary = billingCleanupProject.laneSummaries.find(
      (laneSummary) => laneSummary.id === laneId("project-1", "todo")
    );
    if (!todoLaneSummary) {
      throw new Error("Expected the Todo lane summary to exist");
    }

    for (let taskIndex = 0; taskIndex < 18; taskIndex += 1) {
      tasksWithTallTodo.push({
        body: "",
        createdAt: `2026-03-18T09:${String(taskIndex).padStart(2, "0")}:00.000Z`,
        id: `task-mobile-tall-${taskIndex + 1}`,
        laneId: laneId("project-1", "todo"),
        parentTaskId: null,
        position: tasks.length + taskIndex,
        projectId: "project-1",
        ticketId: `BILL-${taskIndex + 10}`,
        tags: [],
        title: `Mobile tall backlog ${taskIndex + 1}`,
        updatedAt: `2026-03-18T09:${String(taskIndex).padStart(2, "0")}:30.000Z`
      });
    }

    todoLaneSummary.taskCount = tasksWithTallTodo.filter(
      (task) => task.projectId === "project-1" && task.laneId === laneId("project-1", "todo")
    ).length;

    await mockAuthenticated(page, {
      projects: projectsWithTallTodo,
      tasks: tasksWithTallTodo
    });

    await page.goto(billingBoardPath);

    const todoLaneHeader = page.getByTestId(`lane-header-${laneId("project-1", "todo")}`);
    const sourceCard = page.getByTestId("task-card-task-mobile-tall-12");
    const mobileTrashTarget = page.getByTestId("mobile-task-trash-target");
    const deleteDialog = page.getByRole("alertdialog", { name: "Delete task Mobile tall backlog 12" });

    await sourceCard.scrollIntoViewIfNeeded();
    await expect.poll(async () => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
    await expect
      .poll(async () => todoLaneHeader.evaluate((element) => element.getBoundingClientRect().bottom))
      .toBeLessThanOrEqual(0);

    await dragTaskWithTouch(page, taskCardSurface(sourceCard), mobileTrashTarget);

    await expect(deleteDialog).toBeVisible();
    await confirmTaskDelete(page, deleteDialog, "project-1", "task-mobile-tall-12");
    const taskDeleteToast = page.getByTestId("toast-notice");
    await expect(taskDeleteToast).toBeVisible();
    await expect(taskDeleteToast).toContainText("Task deleted");
    await expect(taskDeleteToast).toContainText("Mobile tall backlog 12 (BILL-21) was deleted.");
    await expect(sourceCard).toHaveCount(0, { timeout: 15000 });
    await expect(mobileTrashTarget).toHaveCount(0);
  });

  test("board page lets the mobile header scroll out of view instead of covering content", async ({ page }) => {
    const projectsWithTallTodo = structuredClone(projectsForGrid);
    const tasksWithTallTodo = structuredClone(tasks);
    const billingCleanupProject = projectsWithTallTodo.find((project) => project.id === "project-1");
    if (!billingCleanupProject) {
      throw new Error("Expected project-1 test fixture to exist");
    }

    const todoLaneSummary = billingCleanupProject.laneSummaries.find(
      (laneSummary) => laneSummary.id === laneId("project-1", "todo")
    );
    if (!todoLaneSummary) {
      throw new Error("Expected the Todo lane summary to exist");
    }

    for (let taskIndex = 0; taskIndex < 18; taskIndex += 1) {
      tasksWithTallTodo.push({
        body: "",
        createdAt: `2026-03-18T09:${String(taskIndex).padStart(2, "0")}:00.000Z`,
        id: `task-mobile-tall-${taskIndex + 1}`,
        laneId: laneId("project-1", "todo"),
        parentTaskId: null,
        position: tasks.length + taskIndex,
        projectId: "project-1",
        ticketId: `BILL-${taskIndex + 10}`,
        tags: [],
        title: `Mobile tall backlog ${taskIndex + 1}`,
        updatedAt: `2026-03-18T09:${String(taskIndex).padStart(2, "0")}:30.000Z`
      });
    }

    todoLaneSummary.taskCount = tasksWithTallTodo.filter(
      (task) => task.projectId === "project-1" && task.laneId === laneId("project-1", "todo")
    ).length;

    await mockAuthenticated(page, {
      projects: projectsWithTallTodo,
      tasks: tasksWithTallTodo
    });

    await page.goto(billingBoardPath);

    const topbarShell = page.getByTestId("app-topbar-shell");

    await expect(topbarShell).toBeVisible();
    await expect
      .poll(async () => topbarShell.evaluate((element) => element.getBoundingClientRect().top))
      .toBeGreaterThanOrEqual(0);

    await page.evaluate(() => window.scrollTo({ top: 420, behavior: "auto" }));
    await expect.poll(async () => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
    await expect
      .poll(async () => topbarShell.evaluate((element) => element.getBoundingClientRect().bottom))
      .toBeLessThanOrEqual(0);

    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
    await expect.poll(async () => page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(0);
    await expect
      .poll(async () => topbarShell.evaluate((element) => element.getBoundingClientRect().top))
      .toBeGreaterThanOrEqual(0);
  });

  test("board page adds tasks from the shared lane header action on mobile", async ({ page }) => {
    const todoLaneId = laneId("project-1", "todo");

    await mockAuthenticated(page, { projects: projectsForGrid });

    await page.goto(billingBoardPath);

    const addTaskButton = page.getByTestId(`add-task-button-${todoLaneId}`);
    const composer = page.getByTestId(`lane-composer-${todoLaneId}`);

    await expect(addTaskButton).toBeVisible();
    await addTaskButton.click();
    await expect(composer).toBeVisible();

    const composerInput = composer.getByLabel("New task title for Todo");
    await composerInput.fill("Confirm mobile tap flow");
    await composerInput.press("Enter");

    await expect(page.locator(".task-card__title", { hasText: "Confirm mobile tap flow" })).toBeVisible();
  });

  test("board page creates lanes from the mobile between-lane control", async ({ page }) => {
    const todoLaneId = laneId("project-1", "todo");

    await mockAuthenticated(page, { projects: projectsForGrid });

    await page.goto(billingBoardPath);

    const mobileCreateLaneButton = page.getByTestId(`create-lane-mobile-after-${todoLaneId}`);
    const firstLaneSpacing = await page.locator(".board-column-shell").first().evaluate((element) => {
      const shellStyle = window.getComputedStyle(element);
      const gapButton = element.querySelector<HTMLButtonElement>(".board-lane-gap-mobile");
      const buttonStyle = gapButton ? window.getComputedStyle(gapButton) : null;

      return {
        buttonMarginTop: buttonStyle ? Number.parseFloat(buttonStyle.marginTop) : Number.NaN,
        rowGap: Number.parseFloat(shellStyle.rowGap)
      };
    });

    await expect(mobileCreateLaneButton).toBeVisible();
    await expect(mobileCreateLaneButton.locator("span")).toHaveCount(0);
    expect(firstLaneSpacing.rowGap).toBeLessThanOrEqual(8);
    expect(firstLaneSpacing.buttonMarginTop).toBeLessThanOrEqual(1);
    await mobileCreateLaneButton.click();

    const laneDialog = page.getByRole("dialog", { name: "Create Lane" });
    await expect(laneDialog).toBeVisible();
    await laneDialog.getByLabel("Lane name").fill("Ready for mobile QA");
    await laneDialog.getByRole("button", { exact: true, name: "Create Lane" }).click();

    await expect(page.locator(".board-column__header h2")).toHaveText([
      "Todo",
      "In Progress",
      "In review",
      "Done",
      "Ready for mobile QA"
    ]);
  });
});

test("board page switcher renames and creates projects while guarding protected lanes", async ({ page }) => {
  await mockAuthenticated(page, {
    nextProjectId: 7,
    projects: projectsForGrid
  });

  await page.goto(billingBoardPath);

  const projectsLink = page.getByRole("link", { exact: true, name: "Projects" });
  const switcherButton = page.getByRole("button", { name: "Open project switcher" });
  const todoLink = page.getByRole("link", { exact: true, name: "TODOs" });
  const [projectsBox, switcherBox, todoBox] = await Promise.all([
    projectsLink.boundingBox(),
    switcherButton.boundingBox(),
    todoLink.boundingBox()
  ]);
  expect(projectsBox).not.toBeNull();
  expect(switcherBox).not.toBeNull();
  expect(todoBox).not.toBeNull();
  expect((projectsBox?.x ?? 0) - (todoBox?.x ?? 0)).toBeGreaterThan(24);
  expect((switcherBox?.x ?? 0) - (todoBox?.x ?? 0)).toBeGreaterThan(24);

  await switcherButton.click();

  const switcherInput = page.getByLabel("Project switcher input");
  await switcherInput.fill("road");
  await expect(page.getByRole("button", { name: "Open project Roadmap review" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open project Billing cleanup" })).toHaveCount(0);
  await page.getByRole("button", { name: "Open project Roadmap review" }).click();

  await expect(page).toHaveURL(/\/projects\/ROAD$/);
  await expect(page.locator(".subnav__current-value")).toHaveText("Roadmap review");

  await page.goto(billingBoardPath);
  await switcherButton.click();
  await switcherInput.fill("Billing relaunch");
  await page.getByRole("button", { name: "Rename Project" }).click();
  await expect(page).toHaveURL(/\/projects\/BILL$/);
  await expect(page.locator(".subnav__current-value")).toHaveText("Billing relaunch");

  await switcherButton.click();
  await switcherInput.fill("Program rollout");
  await page.getByRole("button", { name: "Create Project" }).click();

  const createProjectToast = page.getByTestId("toast-notice");
  await expect(page).toHaveURL(/\/projects\/PROG$/);
  await expect(createProjectToast).toBeVisible();
  await expect(createProjectToast).toContainText("Board created");
  await expect(createProjectToast).toContainText("Created board Program rollout.");
  await expect(page.locator(".subnav__current-value")).toHaveText("Program rollout");
  await expect(page.locator(".board-column__header h2")).toHaveText([
    "Todo",
    "In Progress",
    "In review",
    "Done"
  ]);

  await expect(page.getByLabel("Delete lane Todo")).toHaveCount(0);
  await expect(page.getByLabel("Delete lane Done")).toHaveCount(0);

  for (const laneName of ["In Progress", "In review"]) {
    await page.getByLabel(`Delete lane ${laneName}`).click();
    const deleteDialog = page.getByRole("alertdialog", { name: `Delete lane ${laneName}` });
    await expect(deleteDialog).toBeVisible();
    await deleteDialog.getByRole("button", { exact: true, name: "Delete" }).click();
    await expect(page.getByRole("heading", { name: laneName })).toHaveCount(0);
  }

  await expect(page.locator(".board-column__header h2")).toHaveText(["Todo", "Done"]);
  await expect(page.getByLabel("Delete lane Todo")).toHaveCount(0);
  await expect(page.getByLabel("Delete lane Done")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Done" })).toBeVisible();
  await expect(page.getByText("Todo and Done lanes cannot be deleted.")).toHaveCount(0);

  await switcherButton.click();
  await switcherInput.fill("12345");
  await page.getByRole("button", { name: "Create Project" }).click();

  await expect(page).toHaveURL(/\/projects\/AAAA$/);
  await expect(page.locator(".subnav__current-value")).toHaveText("12345");
  await expect(page.locator(".board-column__header h2")).toHaveText([
    "Todo",
    "In Progress",
    "In review",
    "Done"
  ]);
});
