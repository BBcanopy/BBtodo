import { expect, test, type Page } from "@playwright/test";

import { mockAuthenticated } from "./fixtures";

async function chooseSetting(page: Page, name: string) {
  await page.getByRole("button", { name: "Project settings", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Project settings", exact: true });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name, exact: true }).click();
}

test("settings support keyboard navigation and rename updates the board, Projects, and TODOs", async ({ page }) => {
  await mockAuthenticated(page);
  let renames = 0;
  page.on("request", (request) => {
    if (request.method() === "PATCH" && request.url().endsWith("/api/v1/projects/project-1") && request.postDataJSON().name) {
      renames += 1;
    }
  });
  await page.goto("/todos");
  await page.getByRole("button", { name: "Open board Billing cleanup", exact: true }).click();
  const settings = page.getByRole("button", { name: "Project settings", exact: true });
  await settings.press("Enter");
  const menu = page.getByRole("menu", { name: "Project settings", exact: true });
  await expect(menu.getByRole("menuitem", { name: "Archive", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Delete", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Rename", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");

  const rename = page.getByRole("dialog", { name: /^Rename project / });
  const name = rename.getByLabel("Project name", { exact: true });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("Billing cleanup");
  await name.fill(" ");
  await expect(rename.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await rename.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(rename).toHaveCount(0);
  await expect(settings).toBeFocused();
  expect(renames).toBe(0);

  await chooseSetting(page, "Rename");
  await name.fill("Billing relaunch");
  await name.press("Enter");
  await expect(rename).toHaveCount(0);
  await expect(page).toHaveURL("/projects/BILL");
  await expect(page.locator(".subnav__current-value")).toHaveText("Billing relaunch");
  expect(renames).toBe(1);

  await page.getByRole("link", { name: "TODOs", exact: true }).click();
  await expect(page.getByTestId("todo-project-group-project-1").getByRole("heading")).toHaveText("Billing relaunch");
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await expect(page.getByTestId("project-card-project-1").getByRole("heading")).toHaveText("Billing relaunch");
  await expect(settings).toHaveCount(0);
});

test("rename failures keep the draft available for retry", async ({ page }) => {
  await mockAuthenticated(page);
  let failRename = true;
  await page.route("**/api/v1/projects/project-1", async (route) => {
    if (route.request().method() === "PATCH" && failRename) {
      failRename = false;
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "Rename failed" }) });
      return;
    }
    await route.fallback();
  });
  await page.goto("/projects/BILL");
  await chooseSetting(page, "Rename");
  const rename = page.getByRole("dialog", { name: /^Rename project / });
  await rename.getByLabel("Project name", { exact: true }).fill("Retry rename");
  await rename.getByRole("button", { name: "Save", exact: true }).click();
  await expect(rename.getByText("Rename failed", { exact: true })).toBeVisible();
  await expect(rename.getByLabel("Project name", { exact: true })).toHaveValue("Retry rename");
  await expect(page.locator(".subnav__current-value")).toHaveText("Billing cleanup");
  await rename.getByRole("button", { name: "Save", exact: true }).click();
  await expect(rename).toHaveCount(0);
  await expect(page.locator(".subnav__current-value")).toHaveText("Retry rename");
});

test("opening and closing the selector keeps settings disabled during a pending rename", async ({ page }) => {
  await mockAuthenticated(page);
  let releaseRename!: () => void;
  const pendingRename = new Promise<void>((resolve) => { releaseRename = resolve; });
  await page.route("**/api/v1/projects/project-1", async (route) => {
    if (route.request().method() === "PATCH") {
      await pendingRename;
    }
    await route.fallback();
  });
  await page.goto("/projects/BILL");
  await chooseSetting(page, "Rename");
  const rename = page.getByRole("dialog", { name: /^Rename project / });
  await rename.getByLabel("Project name", { exact: true }).fill("Pending rename");
  await rename.getByRole("button", { name: "Save", exact: true }).click();
  const settings = page.getByRole("button", { name: "Project settings", exact: true });
  await expect(settings).toBeDisabled();
  await page.getByLabel("Open project switcher").click();
  await page.getByLabel("Open project switcher").click();
  await expect(settings).toBeDisabled();
  releaseRename();
  await expect(page.locator(".subnav__current-value")).toHaveText("Pending rename");
  await expect(settings).toBeEnabled();
});

test("delete requires confirmation, preserves the board on failure, and returns to Projects on success", async ({ page }) => {
  await mockAuthenticated(page);
  let deletes = 0;
  let failDelete = true;
  let releaseDelete!: () => void;
  const pendingDelete = new Promise<void>((resolve) => { releaseDelete = resolve; });
  page.on("request", (request) => {
    if (request.method() === "DELETE" && request.url().endsWith("/api/v1/projects/project-1")) {
      deletes += 1;
    }
  });
  await page.route("**/api/v1/projects/project-1", async (route) => {
    if (route.request().method() === "DELETE" && failDelete) {
      await pendingDelete;
      failDelete = false;
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "Delete failed" }) });
      return;
    }
    await route.fallback();
  });
  await page.goto("/todos");
  await expect(page.getByTestId("todos-nav-count")).toHaveText("2 todos");
  await page.getByRole("button", { name: "Open board Billing cleanup", exact: true }).click();
  await chooseSetting(page, "Delete");
  const confirmation = page.getByRole("alertdialog", { name: "Delete project Billing cleanup", exact: true });
  await expect(confirmation).toContainText("The project and all its tasks will be permanently deleted.");
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByTestId("task-card-task-1")).toBeVisible();
  expect(deletes).toBe(0);
  await chooseSetting(page, "Delete");
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  expect(deletes).toBe(0);

  await chooseSetting(page, "Delete");
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("button", { name: "Project settings", exact: true })).toBeDisabled();
  releaseDelete();
  await expect(page.getByText("Delete failed", { exact: true })).toBeVisible();
  await expect(page.getByTestId("task-card-task-1")).toBeVisible();
  await expect(page).toHaveURL("/projects/BILL");
  expect(deletes).toBe(1);

  await chooseSetting(page, "Delete");
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByTestId("project-card-project-1")).toHaveCount(0);
  await expect(page.getByTestId("toast-notice")).toContainText("Board deleted");
  expect(deletes).toBe(2);
  await page.getByRole("link", { name: "TODOs", exact: true }).click();
  await expect(page.getByTestId("todos-nav-count")).toHaveText("0 todos");
  await expect(page.getByTestId("todo-project-group-project-1")).toHaveCount(0);
});
