import { expect, test } from "@playwright/test";

import { laneId, mockAuthenticated, projectsForGrid, selectTodoStatus, tag, tasks } from "./fixtures";

function createCaptureEvidenceTask() {
  return {
    body: "Collect evidence from the callback logs before changing the retry window.",
    createdAt: "2026-03-18T07:12:00.000Z",
    id: "task-5",
    laneId: laneId("project-1", "todo"),
    parentTaskId: "task-1",
    position: 0,
    projectId: "project-1",
    ticketId: "BILL-5",
    tags: [tag("retry", "coral")],
    title: "Capture callback evidence",
    updatedAt: "2026-03-18T07:22:00.000Z"
  };
}

function createPartnerReviewTask() {
  return {
    body: "Pull the remaining vendor notes into one review pass.",
    createdAt: "2026-03-18T08:35:00.000Z",
    id: "task-6",
    laneId: laneId("project-6", "todo"),
    parentTaskId: null,
    position: 0,
    projectId: "project-6",
    ticketId: "PART-1",
    tags: [tag("partner", "orchid")],
    title: "Review partner notes",
    updatedAt: "2026-03-18T08:55:00.000Z"
  };
}

function buildTodoFixtures(extraTasks: (typeof tasks)[number][] = []) {
  const todoProjects = structuredClone(projectsForGrid);
  const todoTasks = structuredClone(tasks);
  todoTasks.push(...extraTasks);

  return {
    todoProjects,
    todoTasks
  };
}

test("all todos page groups todo tasks and supports search and tag filtering", async ({ page }) => {
  const { todoProjects, todoTasks } = buildTodoFixtures([createCaptureEvidenceTask(), createPartnerReviewTask()]);

  await mockAuthenticated(page, {
    projects: todoProjects,
    tasks: todoTasks
  });

  await page.goto("/");
  await selectTodoStatus(page);

  await expect(page).toHaveURL("/todos");
  await expect(page).toHaveTitle("All TODOs | BBTodo");
  await expect(page.getByLabel("Search todos")).toBeVisible();
  await expect(page.getByLabel("Filter by tags")).toBeVisible();
  await expect(page.getByTestId("todos-nav-count")).toHaveText("4 todos");
  await expect(page.locator(".page-shell--todos .page-header")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "All TODOs" })).toHaveCount(0);
  await expect(page.getByText("Cross-project view")).toHaveCount(0);
  await expect(page.getByText("Everything still sitting in Todo, grouped by board so you can review the queue before diving into a lane.")).toHaveCount(0);
  await expect(page.locator(".metric-ribbon")).toHaveCount(0);

  const billingGroup = page.getByTestId("todo-project-group-project-1");
  const partnerGroup = page.getByTestId("todo-project-group-project-6");

  await expect(billingGroup.getByRole("heading", { name: "Billing cleanup" })).toBeVisible();
  await expect(partnerGroup.getByRole("heading", { name: "Partner audit" })).toBeVisible();
  await expect(billingGroup.locator(".todos-project__meta")).toContainText("3 total");
  await expect(billingGroup.locator(".todos-project__meta")).not.toContainText("visible");

  const [billingGroupBox, partnerGroupBox] = await Promise.all([
    billingGroup.boundingBox(),
    partnerGroup.boundingBox()
  ]);
  expect(billingGroupBox).not.toBeNull();
  expect(partnerGroupBox).not.toBeNull();
  const columnOffset = Math.abs((partnerGroupBox?.x ?? 0) - (billingGroupBox?.x ?? 0));
  const rowOffset = Math.abs((partnerGroupBox?.y ?? 0) - (billingGroupBox?.y ?? 0));
  const columnThreshold = (billingGroupBox?.width ?? 0) * 0.5;
  const rowThreshold = (billingGroupBox?.height ?? 0) * 0.5;
  expect(columnOffset).toBeGreaterThan(columnThreshold);
  expect(rowOffset).toBeLessThan(rowThreshold);

  const billingHeading = billingGroup.getByRole("heading", { name: "Billing cleanup" });
  const billingPrefix = billingGroup.locator(".todos-project__eyebrow");
  const [billingHeadingBox, billingPrefixBox] = await Promise.all([
    billingHeading.boundingBox(),
    billingPrefix.boundingBox()
  ]);
  expect(billingHeadingBox).not.toBeNull();
  expect(billingPrefixBox).not.toBeNull();
  expect(Math.abs((billingHeadingBox?.y ?? 0) - (billingPrefixBox?.y ?? 0))).toBeLessThan(24);
  expect((billingPrefixBox?.x ?? 0) - (billingHeadingBox?.x ?? 0)).toBeGreaterThan(24);

  await expect(billingGroup.getByTestId("todo-task-card-task-1")).toBeVisible();
  await expect(billingGroup.getByTestId("todo-task-card-task-5")).toBeVisible();
  await expect(billingGroup.getByTestId("todo-task-card-task-4")).toBeVisible();
  await expect(billingGroup.getByLabel("Open todo BILL-1")).toHaveCSS("cursor", "pointer");

  const billingTaskOrder = await billingGroup
    .locator("[data-testid^='todo-task-card-'] .task-card__title")
    .allTextContents();
  expect(billingTaskOrder).toEqual([
    "[BILL-1] Review retry settings",
    "[BILL-5] Capture callback evidence",
    "[BILL-4] Queue copy pass"
  ]);

  await page.getByLabel("Search todos").fill("partner");
  await expect(partnerGroup).toBeVisible();
  await expect(billingGroup).toHaveCount(0);

  await page.getByLabel("Search todos").fill("");
  await billingGroup.getByTestId("todo-task-card-task-5").getByRole("button", { name: "retry" }).click();

  await expect(partnerGroup).toHaveCount(0);
  await expect(billingGroup.getByTestId("todo-task-card-task-1")).toBeVisible();
  await expect(billingGroup.getByTestId("todo-task-card-task-5")).toBeVisible();
  await expect(billingGroup.getByTestId("todo-task-card-task-4")).toHaveCount(0);
});

test("all todos page links into boards and task detail boards", async ({ page }) => {
  const { todoProjects, todoTasks } = buildTodoFixtures([createPartnerReviewTask()]);

  await mockAuthenticated(page, {
    projects: todoProjects,
    tasks: todoTasks
  });

  await page.goto("/todos");

  await page.getByRole("button", { name: "Open board Billing cleanup" }).click();
  await expect(page).toHaveURL("/projects/BILL");
  await expect(page.getByTestId("todos-nav-count")).toHaveCount(0);

  await page.goto("/todos");
  await page.getByLabel("Open todo PART-1").click();
  await expect(page).toHaveURL("/projects/PART/PART-1");
  await expect(page.getByTestId("todos-nav-count")).toHaveCount(0);
});

test("all todos page shows the empty state when no todo tasks exist", async ({ page }) => {
  await mockAuthenticated(page, {
    projects: structuredClone(projectsForGrid),
    tasks: []
  });

  await page.goto("/todos");

  await expect(page.getByRole("heading", { name: "No TODOs yet." })).toBeVisible();
  await expect(
    page.getByText("Every board is either empty or already moving beyond the Todo lane.")
  ).toBeVisible();
});

test("all todos page shows the no-match state when filters remove every todo", async ({ page }) => {
  const { todoProjects: searchableProjects, todoTasks: searchableTasks } = buildTodoFixtures([
    createPartnerReviewTask()
  ]);

  await mockAuthenticated(page, {
    projects: searchableProjects,
    tasks: searchableTasks
  });

  await page.goto("/todos");
  await page.getByLabel("Search todos").fill("missing");

  await expect(page.getByRole("heading", { name: "No TODOs match the current filters." })).toBeVisible();
  await expect(
    page.getByText("Try a different search term or remove the active tag filter.")
  ).toBeVisible();
});

function buildStatusFixtures() {
  const statusProjects = structuredClone(projectsForGrid);
  const billing = statusProjects.find((project) => project.id === "project-1")!;
  const other = statusProjects.find((project) => project.id === "project-2")!;
  const customLane = { ...billing.laneSummaries[0], id: "billing-qa", name: "Ready   for QA", position: 4 };
  billing.laneSummaries.push(customLane);
  other.laneSummaries.push({ ...other.laneSummaries[0], id: "other-qa", name: "ready for qa", position: 4 });
  billing.laneSummaries.push({ ...customLane, id: "billing-blocked", name: "Blocked", position: 5 });
  const archived = statusProjects.find((project) => project.id === "project-6")!;
  archived.archived = true;
  archived.laneSummaries.push({ ...archived.laneSummaries[0], id: "archived-only", name: "Archived only", position: 4 });
  const statusTasks = structuredClone(tasks);
  statusTasks.push(
    { ...statusTasks[1], id: "review-task", ticketId: "BILL-5", laneId: laneId("project-1", "in_review"), title: "Review release" },
    { ...statusTasks[1], id: "qa-task", ticketId: "BILL-6", laneId: customLane.id, title: "Verify release" }
  );
  return { projects: statusProjects, tasks: statusTasks };
}

test("status selection preserves task and tag filters, URL history, and reloads", async ({ page }) => {
  await mockAuthenticated(page, buildStatusFixtures());
  await page.goto("/todos?q=callback&tags=oidc");
  await expect(page.getByTestId("todo-status-trigger")).toHaveText("Todo");
  await selectTodoStatus(page, "In Progress");
  await expect(page).toHaveURL("/todos?q=callback&tags=oidc&status=In+Progress");
  await expect(page.getByTestId("todo-status-trigger")).toHaveText("In Progress");
  await expect(page.getByTestId("todo-task-card-task-2")).toBeVisible();
  await expect(page.getByTestId("todo-task-card-task-1")).toHaveCount(0);
  await expect(page.getByTestId("todos-nav-count")).toHaveText("1 task");
  await expect(page).toHaveTitle("In Progress tasks | BBTodo");
  await page.reload();
  await expect(page.getByTestId("todo-task-card-task-2")).toBeVisible();
  await selectTodoStatus(page, "Done");
  await expect(page.getByRole("heading", { name: "No tasks match the current filters." })).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("todo-status-trigger")).toHaveText("In Progress");
  await expect(page.getByTestId("todo-task-card-task-2")).toBeVisible();
  await selectTodoStatus(page);
  await expect(page).toHaveURL("/todos?q=callback&tags=oidc");
  await expect(page.getByTestId("todo-status-trigger")).toHaveText("Todo");
});

test("status dropdown searches and deduplicates active custom lanes and supports keyboard selection", async ({ page }) => {
  await mockAuthenticated(page, buildStatusFixtures());
  await page.goto("/");
  const trigger = page.getByTestId("todo-status-trigger");
  await trigger.click();
  const search = page.getByRole("combobox", { name: "Search statuses" });
  await expect(search).toBeFocused();
  await expect(page.getByRole("option")).toHaveText(["Todo✓", "In Progress", "In review", "Done", "Blocked", "Ready for QA"]);
  await expect(page.getByRole("option", { name: "All statuses", exact: true })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "Archived only", exact: true })).toHaveCount(0);
  await expect(page.getByRole("option", { selected: true })).toHaveCount(1);
  await search.fill("missing status");
  await expect(page.getByText("No matching statuses.")).toBeVisible();
  await expect(trigger).toHaveText("Todo");
  await expect(page).toHaveURL("/");
  await search.fill("  ReAdY  ");
  await expect(page.getByRole("option")).toHaveCount(1);
  await search.press("Enter");
  await expect(page).toHaveURL("/todos?status=Ready+for+QA");
  await expect(trigger).toHaveText("Ready for QA");
  await expect(page.getByTestId("todo-task-card-qa-task")).toBeVisible();
  await expect(page.getByTestId("todo-task-card-task-2")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(search).toHaveValue("");
  await expect(page.getByRole("option", { selected: true })).toHaveText("Ready for QA✓");
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByLabel("Search todos").click();
  await expect(search).toHaveCount(0);
  await trigger.click();
  await search.press("ArrowDown");
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(trigger).toHaveText("In review");
  await expect(page.getByTestId("todo-task-card-review-task")).toBeVisible();
  await trigger.click();
  await search.press("ArrowUp");
  await search.press("Enter");
  await expect(trigger).toHaveText("Ready for QA");
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`status dropdown navigates from boards and stays within a ${viewport.width}px viewport`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockAuthenticated(page, buildStatusFixtures());
    await page.goto("/projects/BILL?q=unrelated&tags=backend");
    await page.getByTestId("todo-status-trigger").click();
    await expect(page.getByRole("combobox", { name: "Search statuses" })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("option", { name: "Done", exact: true })).toBeInViewport({ ratio: 1 });
    const dropdownBox = await page.locator(".todo-status-switcher__dropdown").boundingBox();
    expect(dropdownBox).not.toBeNull();
    expect(dropdownBox!.x).toBeGreaterThanOrEqual(0);
    expect(dropdownBox!.x + dropdownBox!.width).toBeLessThanOrEqual(viewport.width);
    await page.getByRole("option", { name: "Done", exact: true }).click();
    await expect(page).toHaveURL("/todos?status=Done");
    await expect(page.getByTestId("todo-task-card-task-3")).toBeVisible();
    await expect(page.getByTestId("todo-task-card-task-1")).toHaveCount(0);
    await expect(page.getByTestId("todo-status-trigger")).toHaveText("Done");
    await selectTodoStatus(page, "Blocked");
    await expect(page.getByRole("heading", { name: "No tasks in Blocked." })).toBeVisible();
    await expect(page).toHaveTitle("Blocked tasks | BBTodo");
    await page.getByRole("link", { name: "Projects", exact: true }).click();
    await expect(page.getByTestId("todo-status-trigger")).toHaveText("Todo");
  });
}

test("status dropdown shows loading and API failure states", async ({ page }) => {
  await mockAuthenticated(page);
  let releaseRequest!: () => void;
  const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
  await page.route("**/api/v1/projects", async (route) => {
    await requestGate;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Could not load board statuses." }) });
  });
  await page.goto("/settings/api-tokens");
  await page.getByTestId("todo-status-trigger").click();
  await expect(page.getByText("Loading statuses...")).toBeVisible();
  releaseRequest();
  await expect(page.getByText("Could not load board statuses.")).toBeVisible();
  await expect(page.getByRole("option")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Search statuses" }).press("Enter");
  await expect(page).toHaveURL("/settings/api-tokens");
});
