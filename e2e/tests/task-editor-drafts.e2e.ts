import { expect, test, type Page, type Request } from "@playwright/test";

import { laneId, mockAuthenticated, projectsForGrid, tasks } from "./fixtures";

const apiRoutes = "**/api/v1/**";
const typedBody = "Paragraph the server has not seen yet";

function isTaskSave(request: Request) {
  return request.method() === "PATCH" && request.url().includes("/tasks/");
}

async function failApi(page: Page, status: number, message: string) {
  const handler = (route: Parameters<Parameters<Page["route"]>[1]>[0]) =>
    route.fulfill({
      body: JSON.stringify({ message }),
      contentType: "application/json",
      status
    });

  await page.route(apiRoutes, handler);

  return () => page.unroute(apiRoutes, handler);
}

// TanStack Query refetches stale queries, including /me, when a tab becomes visible again.
async function refocusTabUntilMeFails(page: Page, status: number) {
  const meResponse = page.waitForResponse(
    (response) => response.url().endsWith("/api/v1/me") && response.status() === status
  );

  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await meResponse;
}

async function openEditor(page: Page) {
  await mockAuthenticated(page, { projects: projectsForGrid, tasks });
  await page.goto("/projects/BILL/BILL-1");

  const editDialog = page.getByRole("dialog", { name: "Edit BILL-1" });
  await expect(editDialog).toBeVisible();

  return editDialog;
}

// Clicking a card on a board replaces its history entry, so Back would leave the app. A separate
// entry for the card makes Back an in-app navigation, like arriving from the todos page.
async function openCardInNewHistoryEntry(page: Page, startPath: string, cardPath: string) {
  await page.goto(startPath);
  await page.evaluate((path) => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, cardPath);
}

// Holds the first card save at the network until released, and records every save as it is sent.
async function holdFirstTaskSave(page: Page) {
  const saves: Array<{ body: string; title: string }> = [];
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  await page.route("**/api/v1/projects/*/tasks/*", async (route) => {
    if (!isTaskSave(route.request())) {
      await route.fallback();
      return;
    }

    saves.push(route.request().postDataJSON());
    if (saves.length === 1) {
      await released;
    }

    await route.fallback();
  });

  return {
    bodies: () => saves.map((save) => save.body),
    lastSave: () => saves.at(-1),
    release: () => release()
  };
}

function wouldPromptBeforeUnload(page: Page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

test("an API outage on tab refocus keeps the open editor and typed text", async ({ page }) => {
  const editDialog = await openEditor(page);
  const endOutage = await failApi(page, 503, "Service unavailable");

  await editDialog.getByLabel("Task body").fill(typedBody);
  await refocusTabUntilMeFails(page, 503);

  await expect(editDialog.getByText("Service unavailable")).toBeVisible();
  await expect(page.getByText("We hit a problem loading your workspace.")).toHaveCount(0);
  await expect(editDialog.getByLabel("Task body")).toHaveValue(typedBody);

  await endOutage();
  const save = page.waitForRequest(isTaskSave);
  await editDialog.getByRole("button", { name: "Save card" }).click();

  expect((await save).postDataJSON().body).toBe(typedBody);
  await expect(editDialog.getByText("Service unavailable")).toHaveCount(0);
});

test("an expired session keeps unsaved edits and offers sign-in in a new tab", async ({ page }) => {
  const editDialog = await openEditor(page);
  const signInAgain = await failApi(page, 401, "Authentication required.");

  await editDialog.getByLabel("Task body").fill(typedBody);
  await refocusTabUntilMeFails(page, 401);

  const signInLink = editDialog.getByRole("link", { name: "Sign in again in a new tab" });
  await expect(signInLink).toHaveAttribute("href", "/auth/login");
  await expect(signInLink).toHaveAttribute("target", "_blank");
  await expect(page.getByRole("button", { name: "Sign in with OIDC" })).toHaveCount(0);
  await expect(editDialog.getByLabel("Task body")).toHaveValue(typedBody);

  await signInAgain();
  const save = page.waitForRequest(isTaskSave);
  await editDialog.getByRole("button", { name: "Save card" }).click();

  expect((await save).postDataJSON().body).toBe(typedBody);
  await expect(signInLink).toHaveCount(0);
  await expect(editDialog).toBeVisible();
});

test("an expired session shows the login page when nothing is unsaved", async ({ page }) => {
  await openEditor(page);
  await failApi(page, 401, "Authentication required.");

  await refocusTabUntilMeFails(page, 401);

  await expect(page.getByRole("button", { name: "Sign in with OIDC" })).toBeVisible();
});

test("a failed /me on first load still shows the workspace error", async ({ page }) => {
  await mockAuthenticated(page, { projects: projectsForGrid, tasks });
  await failApi(page, 503, "Your sign-in provider is temporarily unavailable.");

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "We hit a problem loading your workspace." })).toBeVisible();
  await expect(page.getByText("Your sign-in provider is temporarily unavailable.")).toBeVisible();
});

test("leaving the card before autosave fires still saves the edit", async ({ page }) => {
  await mockAuthenticated(page, { projects: projectsForGrid, tasks });
  await openCardInNewHistoryEntry(page, "/projects/BILL", "/projects/BILL/BILL-1");

  const editDialog = page.getByRole("dialog", { name: "Edit BILL-1" });
  await expect(editDialog).toBeVisible();

  const save = page.waitForRequest(isTaskSave);
  await editDialog.getByLabel("Task body").fill(typedBody);
  await page.goBack();

  await expect(page).toHaveURL(/\/projects\/BILL$/);
  await expect(editDialog).toHaveCount(0);
  expect((await save).postDataJSON().body).toBe(typedBody);

  await page.getByTestId("task-card-task-1").click();
  await expect(editDialog.getByLabel("Task body")).toHaveValue(typedBody);
});

test("going back to another board saves the edit against the card's own board", async ({ page }) => {
  const roadmapCard = {
    ...tasks[0]!,
    id: "task-road-1",
    laneId: laneId("project-2", "todo"),
    projectId: "project-2",
    ticketId: "ROAD-1",
    title: "Plan the roadmap"
  };

  await mockAuthenticated(page, { projects: projectsForGrid, tasks: [...tasks, roadmapCard] });
  await openCardInNewHistoryEntry(page, "/projects/BILL", "/projects/ROAD/ROAD-1");

  const editDialog = page.getByRole("dialog", { name: "Edit ROAD-1" });
  await expect(editDialog).toBeVisible();

  const save = page.waitForRequest(isTaskSave);
  await editDialog.getByLabel("Task body").fill(typedBody);
  await page.goBack();

  await expect(page).toHaveURL(/\/projects\/BILL$/);

  const saveRequest = await save;
  expect(saveRequest.url()).toContain("/projects/project-2/tasks/task-road-1");
  expect(saveRequest.postDataJSON().body).toBe(typedBody);
});

test("leaving the board before autosave fires saves the edit and refreshes the destination", async ({ page }) => {
  await mockAuthenticated(page, { projects: projectsForGrid, tasks });
  await page.goto("/todos");
  await page.getByLabel("Open todo BILL-1").click();

  const editDialog = page.getByRole("dialog", { name: "Edit BILL-1" });
  await expect(editDialog).toBeVisible();

  const save = page.waitForRequest(isTaskSave);
  await editDialog.getByLabel("Title").fill("Renamed before leaving");
  await page.goBack();

  await expect(page).toHaveURL(/\/todos$/);
  expect((await save).postDataJSON().title).toBe("Renamed before leaving");
  await expect(page.getByTestId("todo-task-card-task-1").locator(".task-card__title")).toContainText(
    "Renamed before leaving"
  );
});

test("leaving the card saves typed tags and keeps the old title when the new one is blank", async ({ page }) => {
  await mockAuthenticated(page, { projects: projectsForGrid, tasks });
  await page.goto("/todos");
  await page.getByLabel("Open todo BILL-1").click();

  const editDialog = page.getByRole("dialog", { name: "Edit BILL-1" });
  await expect(editDialog).toBeVisible();

  await editDialog.getByPlaceholder("Add another tag").fill("urgent");
  await editDialog.getByLabel("Title").fill("");
  const save = page.waitForRequest(isTaskSave);
  await editDialog.getByLabel("Task body").fill(typedBody);
  await page.goBack();

  const saved = (await save).postDataJSON();
  expect(saved.title).toBe("Review retry settings");
  expect(saved.body).toBe(typedBody);
  expect(saved.tags.map((tag: { label: string }) => tag.label)).toContain("urgent");
});

test("a save that fails after leaving the card warns that the changes were lost", async ({ page }) => {
  await mockAuthenticated(page, {
    projects: projectsForGrid,
    taskPatchFailuresById: { "task-1": 1 },
    tasks
  });
  await page.goto("/todos");
  await page.getByLabel("Open todo BILL-1").click();

  const editDialog = page.getByRole("dialog", { name: "Edit BILL-1" });
  await expect(editDialog).toBeVisible();

  await editDialog.getByLabel("Task body").fill(typedBody);
  await page.goBack();

  const toast = page.getByTestId("toast-notice");
  await expect(toast).toContainText("Changes not saved");
  await expect(toast).toContainText("BILL-1");
});

test("a card reopened during older saves shows their text and saves last", async ({ page }) => {
  await mockAuthenticated(page, { projects: projectsForGrid, tasks });
  const { bodies, release } = await holdFirstTaskSave(page);
  await page.goto("/todos");
  await page.getByLabel("Open todo BILL-1").click();

  const editDialog = page.getByRole("dialog", { name: "Edit BILL-1" });
  const bodyField = editDialog.getByLabel("Task body");

  await bodyField.fill("Body A");
  await expect.poll(bodies).toEqual(["Body A"]);
  await bodyField.fill("Body B");
  await page.goBack();
  await expect(page).toHaveURL(/\/todos$/);

  await page.getByLabel("Open todo BILL-1").click();
  await expect(bodyField).toHaveValue("Body B");

  await bodyField.fill("Body C");
  await editDialog.getByRole("button", { name: "Save card" }).click();
  await page.waitForTimeout(300);
  expect(bodies()).toEqual(["Body A"]);

  release();
  await expect.poll(bodies).toEqual(["Body A", "Body B", "Body C"]);

  await editDialog.getByRole("button", { exact: true, name: "Close" }).click();
  await expect(editDialog).toHaveCount(0);
  await page.getByTestId("task-card-task-1").click();
  await expect(bodyField).toHaveValue("Body C");
});

test("editing only the title of a reopened card keeps the text from the older save", async ({ page }) => {
  await mockAuthenticated(page, { projects: projectsForGrid, tasks });
  const { bodies, lastSave, release } = await holdFirstTaskSave(page);
  await page.goto("/todos");
  await page.getByLabel("Open todo BILL-1").click();

  const editDialog = page.getByRole("dialog", { name: "Edit BILL-1" });

  await editDialog.getByLabel("Task body").fill("Body A");
  await expect.poll(bodies).toEqual(["Body A"]);
  await editDialog.getByLabel("Task body").fill("Body B");
  await page.goBack();
  await expect(page).toHaveURL(/\/todos$/);

  await page.getByLabel("Open todo BILL-1").click();
  await editDialog.getByLabel("Title").fill("Renamed after reopening");
  await editDialog.getByRole("button", { name: "Save card" }).click();
  release();

  await expect.poll(lastSave).toMatchObject({ body: "Body B", title: "Renamed after reopening" });
});

test("restoring the original text in a reopened card still overwrites the older saves", async ({ page }) => {
  await mockAuthenticated(page, { projects: projectsForGrid, tasks });
  const { bodies, release } = await holdFirstTaskSave(page);
  await page.goto("/todos");
  await page.getByLabel("Open todo BILL-1").click();

  const editDialog = page.getByRole("dialog", { name: "Edit BILL-1" });
  const bodyField = editDialog.getByLabel("Task body");
  const originalBody = await bodyField.inputValue();

  await bodyField.fill("Body A");
  await expect.poll(bodies).toEqual(["Body A"]);
  await page.goBack();
  await expect(page).toHaveURL(/\/todos$/);

  await page.getByLabel("Open todo BILL-1").click();
  await expect(bodyField).toHaveValue("Body A");
  await bodyField.fill(originalBody);
  await editDialog.getByRole("button", { name: "Save card" }).click();
  release();

  await expect.poll(bodies).toEqual(["Body A", originalBody]);
});

test("closing a reopened card sends nothing more once the older saves succeed", async ({ page }) => {
  await mockAuthenticated(page, { projects: projectsForGrid, tasks });
  const { bodies, release } = await holdFirstTaskSave(page);
  await page.goto("/todos");
  await page.getByLabel("Open todo BILL-1").click();

  const editDialog = page.getByRole("dialog", { name: "Edit BILL-1" });
  const bodyField = editDialog.getByLabel("Task body");

  await bodyField.fill("Body A");
  await expect.poll(bodies).toEqual(["Body A"]);
  await page.goBack();
  await expect(page).toHaveURL(/\/todos$/);

  await page.getByLabel("Open todo BILL-1").click();
  await expect(bodyField).toHaveValue("Body A");
  release();

  await expect.poll(() => wouldPromptBeforeUnload(page)).toBe(false);
  await editDialog.getByRole("button", { exact: true, name: "Close" }).click();
  await expect(editDialog).toHaveCount(0);
  expect(bodies()).toEqual(["Body A"]);
});

test("a reopened card saves the older text itself when the older save fails", async ({ page }) => {
  await mockAuthenticated(page, {
    projects: projectsForGrid,
    // Both the save in flight and the closed editor's follow-up save fail.
    taskPatchFailuresById: { "task-1": 2 },
    tasks
  });
  const { bodies, release } = await holdFirstTaskSave(page);
  await page.goto("/todos");
  await page.getByLabel("Open todo BILL-1").click();

  const editDialog = page.getByRole("dialog", { name: "Edit BILL-1" });
  const bodyField = editDialog.getByLabel("Task body");

  await bodyField.fill("Body A");
  await expect.poll(bodies).toEqual(["Body A"]);
  await bodyField.fill("Body B");
  await page.goBack();
  await expect(page).toHaveURL(/\/todos$/);

  await page.getByLabel("Open todo BILL-1").click();
  await expect(bodyField).toHaveValue("Body B");
  release();

  await expect(page.getByTestId("toast-notice")).toContainText("Changes not saved");
  await expect(bodyField).toHaveValue("Body B");
  await expect.poll(() => wouldPromptBeforeUnload(page)).toBe(true);

  await editDialog.getByRole("button", { exact: true, name: "Close" }).click();
  await expect(editDialog).toHaveCount(0);
  expect(bodies()).toEqual(["Body A", "Body B", "Body B"]);

  await page.getByTestId("task-card-task-1").click();
  await expect(bodyField).toHaveValue("Body B");
});

test("losing edits to an expired session warns on the login page", async ({ page }) => {
  await mockAuthenticated(page, { projects: projectsForGrid, tasks });
  await page.goto("/todos");
  await page.getByLabel("Open todo BILL-1").click();

  const editDialog = page.getByRole("dialog", { name: "Edit BILL-1" });
  await expect(editDialog).toBeVisible();

  await failApi(page, 401, "Authentication required.");
  await editDialog.getByLabel("Task body").fill(typedBody);
  await refocusTabUntilMeFails(page, 401);
  await page.goBack();

  await expect(page.getByRole("button", { name: "Sign in with OIDC" })).toBeVisible();

  const toast = page.getByTestId("toast-notice");
  await expect(toast).toContainText("Changes not saved");
  await expect(toast).toContainText("BILL-1");

  await toast.getByRole("button").click();
  await expect(toast).toHaveCount(0);
});

test("closing the tab prompts while an older save is pending and the text matches the card again", async ({
  page
}) => {
  const editDialog = await openEditor(page);
  const { bodies, lastSave, release } = await holdFirstTaskSave(page);
  const bodyField = editDialog.getByLabel("Task body");
  const originalBody = await bodyField.inputValue();

  await bodyField.fill("Intermediate text");
  await expect.poll(bodies).toEqual(["Intermediate text"]);
  await bodyField.fill(originalBody);

  expect(await wouldPromptBeforeUnload(page)).toBe(true);

  release();
  await expect.poll(lastSave).toMatchObject({ body: originalBody });
  await expect.poll(() => wouldPromptBeforeUnload(page)).toBe(false);
});

test("closing the tab prompts while the save from a closed editor is pending", async ({ page }) => {
  await mockAuthenticated(page, { projects: projectsForGrid, tasks });
  const { bodies, release } = await holdFirstTaskSave(page);
  await page.goto("/todos");
  await page.getByLabel("Open todo BILL-1").click();

  const editDialog = page.getByRole("dialog", { name: "Edit BILL-1" });
  await expect(editDialog).toBeVisible();

  await editDialog.getByLabel("Task body").fill(typedBody);
  await page.goBack();
  await expect(page).toHaveURL(/\/todos$/);
  await expect.poll(bodies).toEqual([typedBody]);

  expect(await wouldPromptBeforeUnload(page)).toBe(true);

  release();
  await expect.poll(() => wouldPromptBeforeUnload(page)).toBe(false);
});

test("closing the tab prompts only while there are unsaved edits", async ({ page }) => {
  const editDialog = await openEditor(page);
  const wouldPrompt = () => wouldPromptBeforeUnload(page);

  expect(await wouldPrompt()).toBe(false);

  const dialogTypes: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogTypes.push(dialog.type());
    await dialog.dismiss();
  });

  const save = page.waitForResponse((response) => isTaskSave(response.request()));
  await editDialog.getByLabel("Task body").click();
  await page.keyboard.type("x");
  expect(await wouldPrompt()).toBe(true);

  await page.close({ runBeforeUnload: true });
  await expect.poll(() => dialogTypes).toEqual(["beforeunload"]);
  expect(page.isClosed()).toBe(false);

  await save;
  await expect.poll(wouldPrompt).toBe(false);
});
