import { expect, test, type Locator, type Page } from "@playwright/test";

import { mockAuthenticated, projectsForGrid, tasks } from "./fixtures";

const GRID_BLANK_RIGHT_INSET = 10;
const GRID_BLANK_TOP_OFFSET = 18;
const GRID_BLANK_BOTTOM_OFFSET = 10;
const GRID_BLANK_LEFT_INSET = 8;
const GRID_BLANK_SCAN_STEP = 4;

async function waitForProjectGridCardsToFinishAnimating(projectGrid: Locator) {
  const projectCards = projectGrid.locator(".project-card");
  const projectCardCount = await projectCards.count();

  if (projectCardCount === 0) {
    return;
  }

  await projectCards.nth(projectCardCount - 1).evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map(async (animation) => {
        if (animation.playState === "finished" || animation.playState === "idle") {
          return;
        }

        try {
          await animation.finished;
        } catch {
          // Ignore animations that get canceled while the grid settles.
        }
      })
    );
  });
}

async function waitForProjectCardLayoutToSettle(card: Locator) {
  await expect
    .poll(async () => {
      return card.evaluate((element) => {
        const cardSurface = element.querySelector<HTMLElement>(".project-card__surface");

        if (!cardSurface) {
          return null;
        }

        return {
          height: Math.round(cardSurface.getBoundingClientRect().height),
          rowSpan: getComputedStyle(element).getPropertyValue("--project-card-row-span").trim()
        };
      });
    })
    .not.toBeNull();
}

async function expectQuickCardEntrance(card: Locator) {
  await expect(card).toHaveCSS("animation-name", "card-appear");
  await expect(card).toHaveCSS("animation-duration", "0.12s");
  await expect(card).toHaveCSS("animation-delay", "0s");
}

async function findProjectGridBlankPoint(page: Page) {
  const projectGrid = page.locator(".project-grid");
  await expect(projectGrid).toBeVisible();
  await waitForProjectGridCardsToFinishAnimating(projectGrid);

  let point: { x: number; y: number } | null = null;

  await expect
    .poll(async () => {
      point = await projectGrid.evaluate(
        (
          gridElement,
          { bottomOffset, leftInset, rightInset, scanStep, topOffset }: {
            bottomOffset: number;
            leftInset: number;
            rightInset: number;
            scanStep: number;
            topOffset: number;
          }
        ) => {
          const gridRect = gridElement.getBoundingClientRect();
          const cardRects = Array.from(gridElement.querySelectorAll<HTMLElement>(".project-card")).map((card) =>
            card.getBoundingClientRect()
          );

          const minX = gridRect.left + leftInset;
          const maxX = gridRect.right - rightInset;
          const minY = gridRect.top + topOffset;
          const maxY = gridRect.bottom - bottomOffset;

          const isBlankPoint = (x: number, y: number) =>
            x > gridRect.left &&
            x < gridRect.right &&
            y > gridRect.top &&
            y < gridRect.bottom &&
            !cardRects.some(
              (cardRect) => x >= cardRect.left && x <= cardRect.right && y >= cardRect.top && y <= cardRect.bottom
            );

          for (let y = maxY; y >= minY; y -= scanStep) {
            for (let x = maxX; x >= minX; x -= scanStep) {
              if (isBlankPoint(x, y)) {
                return {
                  x: x - gridRect.left,
                  y: y - gridRect.top
                };
              }
            }
          }

          return null;
        },
        {
          bottomOffset: GRID_BLANK_BOTTOM_OFFSET,
          leftInset: GRID_BLANK_LEFT_INSET,
          rightInset: GRID_BLANK_RIGHT_INSET,
          scanStep: GRID_BLANK_SCAN_STEP,
          topOffset: GRID_BLANK_TOP_OFFSET
        }
      );

      return point !== null;
    })
    .toBe(true);

  if (!point) {
    throw new Error("Could not find a blank point inside the project grid.");
  }

  return { projectGrid, point };
}

test("projects page lists boards, filters project cards, and opens them from the switcher", async ({ page }) => {
  const projectsWithQaLane = structuredClone(projectsForGrid);
  const billingCleanupProject = projectsWithQaLane.find((project) => project.id === "project-1");
  const compactProject = projectsWithQaLane.find((project) => project.id === "project-2");
  if (!billingCleanupProject) {
    throw new Error("Expected project-1 test fixture to exist");
  }
  if (!compactProject) {
    throw new Error("Expected project-2 test fixture to exist");
  }

  billingCleanupProject.laneSummaries.push({
    createdAt: "2026-03-18T08:00:00.000Z",
    id: "project-1-lane-custom-qa",
    name: "Ready for QA",
    position: 4,
    projectId: "project-1",
    taskCount: 0,
    updatedAt: "2026-03-18T08:00:00.000Z"
  });
  compactProject.name = "idc";
  compactProject.laneSummaries = [
    {
      createdAt: "2026-03-18T08:10:00.000Z",
      id: "project-2-lane-done-only",
      name: "Done",
      position: 0,
      projectId: "project-2",
      taskCount: 3,
      updatedAt: "2026-03-18T08:10:00.000Z"
    }
  ];

  await mockAuthenticated(page, { projects: projectsWithQaLane });

  await page.goto("/");

  const brandPill = page.locator(".brand-mark__pill").first();

  await expect(page).toHaveTitle("Projects | BBTodo");
  await expect(brandPill).toHaveText("BB");
  await expect(brandPill).toHaveCSS("font-family", /"IBM Plex Mono"|IBM Plex Mono/);
  await expect
    .poll(() => brandPill.evaluate((element) => getComputedStyle(element).backgroundImage))
    .toContain("rgb(84, 143, 208)");
  await expect
    .poll(() => brandPill.evaluate((element) => getComputedStyle(element).backgroundImage))
    .toContain("rgb(47, 91, 155)");
  await expect(page.locator(".subnav__current-value")).toHaveText("All projects");
  await expect(page.getByRole("button", { name: "Create Lane" })).toHaveCount(0);
  await expect(page.getByLabel("Search cards")).toHaveCount(0);
  const projectSearch = page.getByLabel("Search boards");
  await expect(projectSearch).toBeVisible();

  const projectCard = page.getByTestId("project-card-project-1");
  const projectDeleteButton = projectCard.getByLabel("Delete board Billing cleanup");
  await expect(projectCard.getByRole("heading", { name: "Billing cleanup" })).toBeVisible();
  await expect
    .poll(() => projectCard.evaluate((element) => getComputedStyle(element, "::after").backgroundImage))
    .toBe("none");
  await expect(projectCard.locator(".project-card__lane-pill")).toHaveCount(5);
  for (const laneLabel of ["Todo 2", "In Progress 1", "In review 0", "Done 1", "Ready for QA 0"]) {
    await expect(projectCard.getByLabel(laneLabel)).toBeVisible();
  }
  const compactProjectCard = page.getByTestId("project-card-project-2");
  const regularLanePill = projectCard.locator(".project-card__lane-pill").first();
  const compactLanePill = compactProjectCard.locator(".project-card__lane-pill");
  await expect(compactProjectCard.getByRole("heading", { name: "idc" })).toBeVisible();
  await expect(compactLanePill).toHaveCount(1);
  await expect(compactLanePill).toContainText("Done");

  await projectSearch.fill("partner");
  await expect(page.getByTestId("project-card-project-6")).toBeVisible();
  await expect(projectCard).toHaveCount(0);

  await projectSearch.fill("ROAD");
  await expect(compactProjectCard).toBeVisible();
  await expect(page.getByTestId("project-card-project-6")).toHaveCount(0);

  await projectSearch.fill("missing");
  await expect(page.getByRole("heading", { name: 'No boards match "missing".' })).toBeVisible();
  await expect(page.getByText("Try a different board name or ticket prefix.")).toBeVisible();

  await projectSearch.fill("");
  await expect(projectCard).toBeVisible();

  const regularLanePillHeight = await regularLanePill.evaluate((element) =>
    Math.round(element.getBoundingClientRect().height)
  );
  const compactLanePillHeight = await compactLanePill.evaluate((element) =>
    Math.round(element.getBoundingClientRect().height)
  );

  expect(compactLanePillHeight).toBe(regularLanePillHeight);
  expect(compactLanePillHeight).toBeLessThanOrEqual(67);
  expect(compactLanePillHeight).toBeGreaterThanOrEqual(63);

  await expect(projectDeleteButton).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(projectDeleteButton).toHaveCSS("color", "rgb(47, 119, 116)");
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body, "::after").opacity))
    .toBe("0.65");

  await page.getByLabel("Open account menu").click();
  await page.getByRole("button", { name: "Ember" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "ember");
  await expect
    .poll(() => brandPill.evaluate((element) => getComputedStyle(element).backgroundImage))
    .toContain("rgb(144, 169, 216)");
  await expect
    .poll(() => brandPill.evaluate((element) => getComputedStyle(element).backgroundImage))
    .toContain("rgb(94, 115, 159)");
  await expect(projectDeleteButton).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(projectDeleteButton).toHaveCSS("color", "rgb(184, 94, 63)");
  await page.getByRole("button", { name: "Midnight" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "midnight");
  await expect
    .poll(() => brandPill.evaluate((element) => getComputedStyle(element).backgroundImage))
    .toContain("rgb(90, 162, 228)");
  await expect
    .poll(() => brandPill.evaluate((element) => getComputedStyle(element).backgroundImage))
    .toContain("rgb(31, 77, 130)");
  await expect(projectDeleteButton).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(projectDeleteButton).toHaveCSS("color", "rgb(142, 229, 224)");
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body, "::after").opacity))
    .toBe("0.22");
  await page.getByLabel("Open account menu").click();

  const switcherButton = page.getByRole("button", { name: "Open project switcher" });
  await switcherButton.click();
  const switcherInput = page.getByLabel("Project switcher input");
  await switcherInput.fill("partner");
  await expect(page.getByRole("button", { name: "Open project Partner audit" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open project Billing cleanup" })).toHaveCount(0);
  await page.getByRole("button", { name: "Open project Partner audit" }).click();

  await expect(page).toHaveURL(/\/projects\/PART$/);
  await expect(page.locator(".subnav__current-value")).toHaveText("Partner audit");
});

test("cards load with a brief, unstaggered entrance", async ({ page }) => {
  await mockAuthenticated(page, { disableAnimations: false, projects: projectsForGrid });

  await page.goto("/");
  await expectQuickCardEntrance(page.getByTestId("project-card-project-6"));

  await page.goto("/projects/BILL");
  await expectQuickCardEntrance(page.locator(".board-column").last());
  await expectQuickCardEntrance(page.getByTestId("task-card-task-4"));

  await page.goto("/todos");
  await expectQuickCardEntrance(page.getByTestId("todo-project-group-project-1"));
  await expectQuickCardEntrance(page.getByTestId("todo-task-card-task-4"));
});

test("project cards open on click and delete through a confirmation popover", async ({ page }) => {
  await mockAuthenticated(page, { deleteProjectDelayMs: 1200 });

  await page.goto("/");

  const projectCard = page.getByTestId("project-card-project-1");
  await expect(projectCard).toBeVisible();
  await expect(projectCard.locator(".project-card__timestamp")).toHaveCount(0);

  await projectCard.click();
  await expect(page).toHaveURL(/\/projects\/BILL$/);
  await expect(page.getByTestId("board-grid")).toBeVisible();

  await page.goto("/");

  const deleteButton = page.getByLabel("Delete board Billing cleanup");
  await deleteButton.click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(projectCard).toBeVisible();

  await deleteButton.click();
  await page.getByRole("button", { exact: true, name: "Delete" }).click();
  await page.waitForTimeout(150);
  await expect(page.getByTestId("toast-notice")).toHaveCount(0);
  const deleteToast = page.getByTestId("toast-notice");
  await expect(projectCard).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No active boards." })).toBeVisible();
  await expect(deleteToast).toBeVisible();
  await expect(deleteToast).toContainText("Board deleted");
  await expect(deleteToast).toContainText("Deleted board Billing cleanup.");
});

test("projects page creates a board from grid double-click and keeps the user on the grid", async ({
  page
}) => {
  await mockAuthenticated(page, { nextProjectId: 7, projects: projectsForGrid });

  await page.goto("/");

  const existingProjectCard = page.getByTestId("project-card-project-1");
  const { point, projectGrid } = await findProjectGridBlankPoint(page);

  await projectGrid.dblclick({ position: point });

  const composer = page.getByTestId("project-card-composer");
  await expect(composer).toBeVisible();
  await expect(page).toHaveURL("/");
  await expect(composer).not.toContainText("Create a board in place");
  await expect(composer).not.toContainText(
    "Add a board with Todo, In Progress, In review, and Done, then keep working from the projects grid."
  );

  await composer.getByLabel("New board name").fill("Quality checks");
  await composer.getByRole("button", { name: "Create board" }).click();

  await expect(page).toHaveURL("/");
  await expect(composer).toHaveCount(0);
  const createToast = page.getByTestId("toast-notice");
  await expect(createToast).toBeVisible();
  await expect(createToast).toContainText("Board created");
  await expect(createToast).toContainText("Created board Quality checks.");
  await expect(page.getByTestId("project-card-project-7")).toBeVisible();
  await expect(page.getByTestId("project-card-project-7")).toContainText("Quality checks");
  await expect(page.locator(".project-card").first()).toHaveAttribute("data-testid", "project-card-project-7");

  await existingProjectCard.click();
  await expect(page).toHaveURL(/\/projects\/BILL$/);
});

test("projects page clears search after inline board creation so the new card stays visible", async ({
  page
}) => {
  await mockAuthenticated(page, { nextProjectId: 7, projects: projectsForGrid });

  await page.goto("/");

  const projectSearch = page.getByLabel("Search boards");
  await projectSearch.fill("bill");
  await expect(page).toHaveURL(/\/\?q=bill$/);
  await expect(page.getByTestId("project-card-project-1")).toBeVisible();
  await expect(page.getByTestId("project-card-project-2")).toHaveCount(0);

  const { point, projectGrid } = await findProjectGridBlankPoint(page);
  await projectGrid.dblclick({ position: point });

  const composer = page.getByTestId("project-card-composer");
  await composer.getByLabel("New board name").fill("Quality checks");
  await composer.getByRole("button", { name: "Create board" }).click();

  await expect(page).toHaveURL("/");
  await expect(page.getByLabel("Search boards")).toHaveValue("");
  await expect(page.getByTestId("project-card-project-7")).toBeVisible();
  await expect(page.getByTestId("project-card-project-7")).toContainText("Quality checks");
});

test("projects page lets the inline board composer cancel without creating a board", async ({ page }) => {
  await mockAuthenticated(page, { projects: projectsForGrid });

  await page.goto("/");

  const { point, projectGrid } = await findProjectGridBlankPoint(page);
  await projectGrid.dblclick({ position: point });

  const composer = page.getByTestId("project-card-composer");
  await expect(composer).toBeVisible();

  await composer.getByLabel("New board name").fill("Cancel me");
  await composer.getByLabel("New board name").press("Escape");

  await expect(composer).toHaveCount(0);
  await expect(page.getByText("Cancel me")).toHaveCount(0);
});

test("projects page packs later cards beneath shorter neighbors when a title wraps", async ({ page }) => {
  const projectsWithLongTitle = structuredClone(projectsForGrid);
  const longTitleProject = projectsWithLongTitle.find((project) => project.id === "project-1");
  const regularProject = projectsWithLongTitle.find((project) => project.id === "project-2");
  const packedProject = projectsWithLongTitle.find((project) => project.id === "project-5");

  if (!longTitleProject) {
    throw new Error("Expected project-1 test fixture to exist");
  }

  if (!regularProject) {
    throw new Error("Expected project-2 test fixture to exist");
  }

  if (!packedProject) {
    throw new Error("Expected project-5 test fixture to exist");
  }

  longTitleProject.name = "bbnote-table-insert-picker-review-and-validation-pass";

  await mockAuthenticated(page, { projects: projectsWithLongTitle });

  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto("/");

  const longTitleProjectCard = page.getByTestId("project-card-project-1");
  const regularProjectCard = page.getByTestId("project-card-project-2");
  const packedProjectCard = page.getByTestId("project-card-project-5");

  await expect(
    longTitleProjectCard.getByRole("heading", {
      name: "bbnote-table-insert-picker-review-and-validation-pass"
    })
  ).toBeVisible();

  for (const laneLabel of ["Todo 2", "In Progress 1", "In review 0", "Done 1"]) {
    await expect(longTitleProjectCard.getByLabel(laneLabel)).toBeVisible();
  }

  await Promise.all([
    waitForProjectCardLayoutToSettle(longTitleProjectCard),
    waitForProjectCardLayoutToSettle(regularProjectCard),
    waitForProjectCardLayoutToSettle(packedProjectCard)
  ]);

  await expect
    .poll(async () => {
      return page.evaluate(() => {
        function getProjectCardLayout(testId: string) {
          const card = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
          const cardSurface = card?.querySelector<HTMLElement>(".project-card__surface");

          if (!card || !cardSurface) {
            throw new Error(`Expected ${testId} to exist with a card surface.`);
          }

          const lanePills = Array.from(card.querySelectorAll<HTMLElement>(".project-card__lane-pill"));
          const lastLanePill = lanePills.at(-1) ?? null;
          const cardRect = cardSurface.getBoundingClientRect();
          const lastLanePillRect = lastLanePill?.getBoundingClientRect() ?? null;

          return {
            bottom: Math.round(cardRect.bottom),
            bottomInset: lastLanePillRect ? Math.round((cardRect.bottom - lastLanePillRect.bottom) * 100) / 100 : null,
            clientHeight: cardSurface.clientHeight,
            height: Math.round(cardRect.height),
            left: Math.round(cardRect.left),
            minHeight: Math.round(Number.parseFloat(getComputedStyle(cardSurface).minHeight)),
            scrollHeight: cardSurface.scrollHeight,
            top: Math.round(cardRect.top)
          };
        }

        const regularProjectLayout = getProjectCardLayout("project-card-project-2");
        const longTitleLayout = getProjectCardLayout("project-card-project-1");
        const packedProjectLayout = getProjectCardLayout("project-card-project-5");

        return {
          isPackedBesideLongTitle: packedProjectLayout.left > longTitleLayout.left,
          isPackedUnderShorterNeighbor: packedProjectLayout.top < longTitleLayout.bottom,
          longTitleBottomInsetNonNegative: (longTitleLayout.bottomInset ?? -1) >= 0,
          longTitleFitsWithoutOverflow: longTitleLayout.scrollHeight <= longTitleLayout.clientHeight + 1,
          longTitleGrewPastMinHeight: longTitleLayout.height > longTitleLayout.minHeight,
          longTitleTallerThanRegular: longTitleLayout.height > regularProjectLayout.height,
          regularProjectStayedAtMinHeight: regularProjectLayout.height === regularProjectLayout.minHeight
        };
      });
    })
    .toEqual({
      isPackedBesideLongTitle: true,
      isPackedUnderShorterNeighbor: true,
      longTitleBottomInsetNonNegative: true,
      longTitleFitsWithoutOverflow: true,
      longTitleGrewPastMinHeight: true,
      longTitleTallerThanRegular: true,
      regularProjectStayedAtMinHeight: true
    });
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 }
]) {
  test(`project cards keep long unbroken titles clear of the delete button on ${viewport.name}`, async ({ page }) => {
    const longTitle = "wfeegwegwehrehrtjjtrjtyiyukyuo".repeat(3);
    await mockAuthenticated(page, {
      projects: [{ ...projectsForGrid[0], name: longTitle }]
    });
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/");

    const card = page.getByTestId("project-card-project-1");
    const heading = card.getByRole("heading", { name: longTitle, exact: true });
    const deleteButton = card.getByRole("button", { name: `Delete board ${longTitle}`, exact: true });
    await expect(heading).toHaveText(longTitle);
    await waitForProjectGridCardsToFinishAnimating(page.locator(".project-grid"));

    await expect.poll(async () => heading.evaluate((element) => {
      const surface = element.closest(".project-card__surface")!;
      const action = surface.querySelector(".project-card__delete-menu > button")!;
      const titleBounds = element.getBoundingClientRect();
      const actionBounds = action.getBoundingClientRect();
      const textRange = document.createRange();
      textRange.selectNodeContents(element);
      const lines = Array.from(textRange.getClientRects());

      return {
        textWraps: lines.length > 1,
        textFitsTitle: lines.every((line) => line.left >= titleBounds.left - 1 && line.right <= titleBounds.right + 1),
        textClearsDeleteButton: lines.every((line) =>
          line.right <= actionBounds.left || line.left >= actionBounds.right ||
          line.bottom <= actionBounds.top || line.top >= actionBounds.bottom
        ),
        cardFitsWithoutOverflow: surface.scrollWidth <= surface.clientWidth + 1
      };
    })).toEqual({
      textWraps: true,
      textFitsTitle: true,
      textClearsDeleteButton: true,
      cardFitsWithoutOverflow: true
    });

    await deleteButton.press("Enter");
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await expect(page).toHaveURL("/");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await card.click();
    await expect(page).toHaveURL("/projects/BILL");
  });
}

test("projects search opens an exact ticket id", async ({ page }) => {
  await mockAuthenticated(page, {
    projects: projectsForGrid,
    tasks
  });

  await page.goto("/");

  const searchInput = page.getByLabel("Search boards");
  await searchInput.fill("bill-2");

  const editDialog = page.getByRole("dialog", { name: "Edit BILL-2" });
  const noMatchesHeading = page.getByRole("heading", { name: 'No boards match "bill-2".' });

  await expect(page).toHaveURL(/\/\?q=bill-2$/);
  await expect(editDialog).toHaveCount(0);
  await expect(noMatchesHeading).toHaveCount(0);
  await expect(page.getByTestId("project-card-project-1")).toBeVisible();
  await expect(page.getByTestId("project-card-project-2")).toHaveCount(0);

  await searchInput.press("Enter");

  await expect(page).toHaveURL(/\/projects\/BILL\/BILL-2\?q=BILL-2$/);
  await expect(editDialog).toBeVisible();
  await expect(editDialog.getByLabel("Title")).toHaveValue("Tighten callback logging");
  await expect(page.getByLabel("Search cards")).toHaveValue("BILL-2");

  await page.getByLabel("Close edit task dialog").click();

  await expect(page).toHaveURL(/\/projects\/BILL\?q=BILL-2$/);
  await expect(page.getByTestId("task-card-task-2")).toBeVisible();
  await expect(page.getByTestId("task-card-task-1")).toHaveCount(0);
});

test("projects search shows no matches for an exact ticket id with no matching board prefix", async ({
  page
}) => {
  await mockAuthenticated(page, {
    projects: projectsForGrid,
    tasks
  });

  await page.goto("/");

  await page.getByLabel("Search boards").fill("MISS-1");

  await expect(page).toHaveURL(/\/\?q=MISS-1$/);
  await expect(page.getByRole("heading", { name: 'No boards match "MISS-1".' })).toBeVisible();
  await expect(page.getByText("Try a different board name or ticket prefix.")).toBeVisible();
  await expect(page.getByTestId("project-card-project-1")).toHaveCount(0);
});

test("missing board routes return to projects with a toast", async ({ page }) => {
  await mockAuthenticated(page);

  await page.goto("/projects/NOPE");

  const toast = page.getByTestId("toast-notice");

  await expect(page).toHaveURL("/");
  await expect(page.locator(".subnav__current-value")).toHaveText("All projects");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("Board not found");
  await expect(toast).toContainText("Board NOPE does not exist.");
});

test("auth notice query params show a one-time warning toast after login", async ({ page }) => {
  await mockAuthenticated(page);

  await page.goto("/?authNotice=missing-refresh-token");

  const toast = page.getByTestId("toast-notice");

  await expect(page).toHaveURL("/");
  await expect(toast).toBeVisible();
  await expect(toast).toHaveAttribute("data-tone", "warning");
  await expect(toast).toContainText("Session auto-extension unavailable");
  await expect(toast).toContainText(
    "Signed in successfully, but your OIDC provider did not return a refresh token."
  );
});
