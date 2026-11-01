import { expect, test, type Page } from "@playwright/test";

import { mockAuthenticated, projects, projectsForGrid } from "./fixtures";

async function acceptArchiveConfirmation(page: Page, trigger: () => Promise<void>) {
  await trigger();
  const confirmation = page.getByRole("alertdialog", { name: /^Archive project / });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toBeInViewport({ ratio: 1 });
  await confirmation.getByRole("button", { name: "Archive", exact: true }).click();
}

test("archiving reuses deletion confirmation styling and dismissing leaves the project unchanged", async ({ page }) => {
  await mockAuthenticated(page);
  let archiveUpdates = 0;
  let browserDialogs = 0;
  page.on("dialog", async (dialog) => {
    browserDialogs += 1;
    await dialog.dismiss();
  });
  page.on("request", (request) => {
    if (request.method() === "PATCH" && request.url().endsWith("/api/v1/projects/project-1") && request.postDataJSON().archived) {
      archiveUpdates += 1;
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Delete board Billing cleanup", exact: true }).click();
  const readAppearance = (element: Element) => {
    const styles = getComputedStyle(element);
    return { background: styles.backgroundColor, border: styles.border, radius: styles.borderRadius, shadow: styles.boxShadow };
  };
  const deletionAppearance = await page.getByRole("alertdialog").evaluate(readAppearance);
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByTestId("project-card-project-1").click();
  const action = page.getByRole("button", { name: "Archive board Billing cleanup", exact: true });

  await action.click();
  const dialog = page.getByRole("alertdialog", { name: "Archive project Billing cleanup", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Archive Billing cleanup?");
  await expect(dialog.getByText("It will be hidden. This action can be reverted", { exact: true })).toBeVisible();
  expect(await dialog.evaluate(readAppearance)).toEqual(deletionAppearance);
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  expect(archiveUpdates).toBe(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(action).toBeFocused();
  await action.press("Space");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(action).toBeFocused();
  await action.click();
  await page.getByLabel("Search cards").click();
  await expect(dialog).toHaveCount(0);
  await expect(action).toBeEnabled();
  await expect(page.getByRole("button", { name: "Unarchive board Billing cleanup", exact: true })).toHaveCount(0);
  expect(archiveUpdates).toBe(0);

  await acceptArchiveConfirmation(page, () => action.click());
  await expect(page.getByRole("button", { name: "Unarchive board Billing cleanup", exact: true })).toBeEnabled();
  expect(archiveUpdates).toBe(1);
  expect(browserDialogs).toBe(0);
});

test("project archiving hides the last active board and cached TODOs, then restores both", async ({ page }) => {
  await mockAuthenticated(page);
  await page.goto("/todos");
  await expect(page.getByTestId("todos-nav-count")).toHaveText("2 todos");
  await expect(page.getByTestId("todo-project-group-project-1")).toBeVisible();

  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("button", { name: /^(Archive|Unarchive) board / })).toHaveCount(0);
  await page.getByTestId("project-card-project-1").click();
  await expect(page.getByRole("dialog", { name: "Project switcher" })).toHaveCount(0);
  await acceptArchiveConfirmation(page, () =>
    page.getByRole("button", { name: "Archive board Billing cleanup", exact: true }).click()
  );
  await expect(page).toHaveURL("/projects/BILL");
  await expect(page.getByTestId("toast-notice")).toContainText("Board archived");
  await expect(page.getByTestId("board-grid")).toBeVisible();
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await expect(page.getByTestId("project-card-project-1")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No active boards." })).toBeVisible();
  const showArchived = page.getByRole("checkbox", { name: "Show archived" });
  await expect(showArchived).toBeVisible();
  await expect(showArchived).not.toBeChecked();

  await page.getByRole("link", { name: "TODOs", exact: true }).click();
  await expect(page.getByTestId("todo-project-group-project-1")).toHaveCount(0);
  await expect(page.getByTestId("todos-nav-count")).toHaveText("0 todos");
  await expect(page.getByRole("heading", { name: "No TODOs yet." })).toBeVisible();

  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await showArchived.check();
  const card = page.getByTestId("project-card-project-1");
  await expect(card.getByText("Archived", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Archive|Unarchive) board / })).toHaveCount(0);
  await card.click();
  await page.getByRole("button", { name: "Unarchive board Billing cleanup", exact: true }).press("Enter");
  await expect(page).toHaveURL("/projects/BILL");
  await expect(page.getByTestId("toast-notice")).toContainText("Board unarchived");
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await expect(card.getByText("Archived", { exact: true })).toHaveCount(0);
  await expect(card.getByLabel("Todo 2", { exact: true })).toBeVisible();
  await expect(showArchived).not.toBeChecked();
  await expect(card).toBeVisible();

  await page.getByRole("link", { name: "TODOs", exact: true }).click();
  await expect(page.getByTestId("todo-project-group-project-1")).toBeVisible();
  await expect(page.getByTestId("todos-nav-count")).toHaveText("2 todos");
});

test("show archived uses the URL, preserves search parameters, and survives reload and return navigation", async ({ page }) => {
  const mixedProjects = projectsForGrid.map((project) => ({ ...project, archived: project.id === "project-1" }));
  await mockAuthenticated(page, { projects: mixedProjects });
  await page.goto("/?q=bill&keep=yes&showArchived=false");
  const showArchived = page.getByRole("checkbox", { name: "Show archived" });
  await expect(showArchived).not.toBeChecked();
  await expect(page.getByTestId("project-card-project-1")).toHaveCount(0);

  await showArchived.check();
  await expect(page).toHaveURL("/?q=bill&keep=yes&showArchived=true");
  await expect(page.getByTestId("project-card-project-1")).toBeVisible();
  await expect(page.getByTestId("project-card-project-2")).toHaveCount(0);
  await page.reload();
  await expect(showArchived).toBeChecked();
  await page.getByTestId("project-card-project-1").click();
  await expect(page).toHaveURL("/projects/BILL");
  await page.goBack();
  await expect(page).toHaveURL("/?q=bill&keep=yes&showArchived=true");
  await expect(showArchived).toBeChecked();
  await showArchived.uncheck();
  await expect(page).toHaveURL("/?q=bill&keep=yes");
  await expect(page.getByTestId("project-card-project-1")).toHaveCount(0);
  await page.getByLabel("Search boards").fill("");
  await showArchived.check();
  await expect(page.getByTestId("project-card-project-1")).toBeVisible();
  await expect(page.getByTestId("project-card-project-2")).toBeVisible();

  await page.getByLabel("Open project switcher").click();
  await expect(page.getByRole("button", { name: "Open project Billing cleanup", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open project Roadmap review", exact: true })).toBeVisible();
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 }
]) {
  test(`archive icons explain their action on hover after the tag filter on ${viewport.name}`, async ({ page }) => {
    const mixedProjects = projectsForGrid.map((project) => ({ ...project, archived: project.id === "project-1" }));
    await mockAuthenticated(page, { projects: mixedProjects });
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/?showArchived=true");
    await expect(page.getByTestId("project-card-project-1").getByText("Archived", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^(Archive|Unarchive) board / })).toHaveCount(0);
    await page.getByLabel("Open project switcher").click();
    await expect(page.getByRole("dialog", { name: "Project switcher" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^(Archive|Unarchive) board / })).toHaveCount(0);
    await page.getByRole("button", { name: "Open project Roadmap review", exact: true }).click();

    for (const verb of ["Archive", "Unarchive"]) {
      const action = page.getByRole("button", { name: `${verb} board Roadmap review`, exact: true });
      await expect(action).toBeEnabled();
      await expect(action).toHaveText("");
      await expect(action.locator("svg")).toBeVisible();
      await action.hover();
      await expect(action).toHaveAttribute("title", verb === "Archive"
        ? "Archive project: hide it from active project lists and TODOs."
        : "Unarchive project: show it in active project lists and TODOs.");
      await expect(action).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(action).toHaveCSS("box-shadow", "none");
      await expect(action).toHaveCSS("border-top-width", "0px");
      await expect(page.getByRole("dialog", { name: "Project switcher" })).toHaveCount(0);
      const [tagBounds, actionBounds] = await Promise.all([
        page.locator(".subnav__search--tag-filter").boundingBox(),
        action.boundingBox()
      ]);
      expect(tagBounds).not.toBeNull();
      expect(actionBounds).not.toBeNull();
      if (viewport.name === "desktop") {
        expect(actionBounds!.x).toBeGreaterThanOrEqual(tagBounds!.x + tagBounds!.width + 8);
        expect(Math.abs(actionBounds!.y + actionBounds!.height / 2 - tagBounds!.y - tagBounds!.height / 2)).toBeLessThan(2);
      } else {
        expect(actionBounds!.y).toBeGreaterThanOrEqual(tagBounds!.y + tagBounds!.height + 8);
        expect(actionBounds!.x + actionBounds!.width).toBeCloseTo(tagBounds!.x + tagBounds!.width, 0);
      }
      expect(actionBounds!.x + actionBounds!.width).toBeLessThanOrEqual(viewport.width);
      await page.getByLabel("Open project switcher").click();
      const menu = page.getByRole("dialog", { name: "Project switcher" });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("button", { name: /^(Archive|Unarchive) board / })).toHaveCount(0);
      await page.getByLabel("Open project switcher").click();
      if (verb === "Archive") {
        await acceptArchiveConfirmation(page, () => action.click());
      }
    }

    await page.getByRole("link", { name: "Projects", exact: true }).click();
    await expect(page.getByRole("button", { name: /^(Archive|Unarchive) board / })).toHaveCount(0);
  });
}

for (const viewport of [
  { name: "wide desktop", width: 1920, height: 1080 },
  { name: "mobile", width: 390, height: 844 }
]) {
  test(`archive controls preserve the original search and tag widths on ${viewport.name}`, async ({ page }) => {
    await mockAuthenticated(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/projects/BILL");
    await expect(page.getByRole("button", { name: "Archive board Billing cleanup", exact: true })).toBeVisible();
    const boardSearch = await page.getByLabel("Search cards").boundingBox();
    const boardTags = await page.locator(".subnav__search--tag-filter").boundingBox();
    await page.getByRole("link", { name: "TODOs", exact: true }).click();
    const todoSearch = await page.getByLabel("Search todos").boundingBox();
    const todoTags = await page.locator(".subnav__search--tag-filter").boundingBox();
    expect(boardSearch).not.toBeNull();
    expect(boardTags).not.toBeNull();
    expect(todoSearch).not.toBeNull();
    expect(todoTags).not.toBeNull();
    expect(boardSearch!.width).toBeCloseTo(todoSearch!.width, 0);
    expect(boardTags!.width).toBeCloseTo(todoTags!.width, 0);
  });
}

for (const archived of [false, true]) {
  test(`${archived ? "unarchive" : "archive"} board actions support keyboard input, disable while pending, and preserve state on failure`, async ({ page }) => {
    await mockAuthenticated(page, { projects: projects.map((project) => ({ ...project, archived })) });
    let releaseRequest!: () => void;
    const pendingRequest = new Promise<void>((resolve) => { releaseRequest = resolve; });
    await page.route("**/api/v1/projects/project-1", async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.fallback();
        return;
      }
      await pendingRequest;
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "Archive update failed" }) });
    });
    const path = "/projects/BILL";
    await page.goto(path);
    const action = page.getByRole("button", { name: `${archived ? "Unarchive" : "Archive"} board Billing cleanup`, exact: true });
    if (archived) {
      await action.press("Space");
    } else {
      await acceptArchiveConfirmation(page, () => action.press("Space"));
    }
    await expect(action).toBeDisabled();
    await page.getByLabel("Open project switcher").click();
    const menu = page.getByRole("dialog", { name: "Project switcher" });
    await expect(menu.getByRole("button", { name: "Rename Project", exact: true })).toBeDisabled();
    await page.getByLabel("Open project switcher").click();
    await expect(action).toBeDisabled();
    const iconBounds = await action.locator("svg").boundingBox();
    if (!iconBounds) {
      throw new Error("Expected the pending archive control to remain visible.");
    }
    await page.mouse.click(iconBounds.x + iconBounds.width / 2, iconBounds.y + iconBounds.height / 2);
    await expect(page.getByTestId("board-grid")).toBeVisible();
    await expect(page).toHaveURL(path);
    releaseRequest();
    await expect(page.getByText("Archive update failed", { exact: true })).toBeVisible();
    await expect(action).toBeEnabled();
    await expect(page).toHaveURL(path);
    await page.getByRole("link", { name: "Projects", exact: true }).click();
    await page.getByRole("checkbox", { name: "Show archived" }).check();
    const card = page.getByTestId("project-card-project-1");
    await expect(card).toBeVisible();
    await expect(card.getByText("Archived", { exact: true })).toHaveCount(archived ? 1 : 0);
  });
}

test("archived board and ticket links remain editable with named navigation and active-only pickers", async ({ page }) => {
  const mixedProjects = projectsForGrid.map((project) => ({ ...project, archived: project.id === "project-1" || project.id === "project-2" }));
  await mockAuthenticated(page, { projects: mixedProjects });
  await page.goto("/projects/BILL");
  await expect(page.getByTestId("board-grid")).toBeVisible();
  await expect(page.locator(".subnav__current-value")).toHaveText("Billing cleanup");
  await page.getByLabel("Open project switcher").click();
  await expect(page.getByRole("button", { name: "Open project Billing cleanup", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open project Roadmap review", exact: true })).toHaveCount(0);
  await page.getByLabel("Project switcher input").fill("Archived billing");
  await page.getByRole("button", { name: "Rename Project", exact: true }).click();
  await expect(page.locator(".subnav__current-value")).toHaveText("Archived billing");

  await page.goto("/projects/BILL/BILL-1");
  const editor = page.getByRole("dialog");
  await expect(editor).toBeVisible();
  await editor.getByTestId("move-card-trigger").click();
  const movePicker = editor.getByTestId("move-card-project-list");
  await expect(movePicker.getByTestId("move-card-project-option-project-2")).toHaveCount(0);
  await expect(movePicker.getByTestId("move-card-project-option-project-3")).toBeVisible();
  await editor.getByTestId("move-card-trigger").click();
  await editor.getByLabel("Title", { exact: true }).fill("Edited archived ticket");
  await editor.getByRole("button", { name: "Save card", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("dialog").getByLabel("Title", { exact: true })).toHaveValue("Edited archived ticket");
});

test("project creation and deletion keep active and inclusive project lists coherent", async ({ page }) => {
  const mixedProjects = projectsForGrid.slice(0, 2).map((project) => ({ ...project, archived: project.id === "project-2" }));
  await mockAuthenticated(page, { projects: mixedProjects, nextProjectId: 7, deleteProjectDelayMs: 400 });
  await page.goto("/?showArchived=true");
  await expect(page.getByTestId("project-card-project-2")).toBeVisible();
  await page.getByLabel("Open project switcher").click();
  await page.getByLabel("Project switcher input").fill("Fresh board");
  await page.getByRole("button", { name: "Create Project", exact: true }).click();
  await expect(page).toHaveURL("/projects/FRES");
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await expect(page.getByTestId("project-card-project-7")).toBeVisible();
  await page.getByLabel("Show archived").check();
  const card = page.getByTestId("project-card-project-7");
  await expect(card).toBeVisible();
  await card.getByLabel("Delete board Fresh board").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("toast-notice")).toContainText("Board deleted");
  await page.getByLabel("Show archived").uncheck();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("project-card-project-1")).toBeVisible();
});
