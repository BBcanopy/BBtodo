import { expect, test } from "@playwright/test";

import { mockAuthenticated, projectsForGrid, tasks } from "./fixtures";

const codeBody = [
  "Run `apt clean` before checking the logs.",
  "",
  "```sh",
  "# Clear cached packages",
  "apt autoremove -y",
  "```",
  "",
  "```",
  "journalctl --rotate",
  "```",
  "",
  "    history -c"
].join("\n");

for (const viewport of [{ width: 1500, height: 900 }, { width: 390, height: 844 }]) {
  test(`keeps code preview contrast readable across themes at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockAuthenticated(page, {
      projects: projectsForGrid,
      tasks: tasks.map((task) => task.id === "task-1" ? { ...task, body: codeBody } : task)
    });
    await page.goto("/projects/BILL");

    // Return to Midnight after the light themes to catch stale colors when switching themes.
    for (const theme of ["midnight", "sea", "ember", "midnight"]) {
      await page.getByLabel("Open account menu").click();
      await page.getByRole("menu").getByRole("button", { name: new RegExp(`^${theme}$`, "i") }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.getByLabel("Open account menu").click();

      await page.getByTestId("task-card-task-1").click();
      const editor = page.getByRole("dialog", { name: "Edit BILL-1" });
      await editor.getByRole("tab", { name: "Rendered preview" }).click();
      const preview = editor.getByTestId("task-markdown-preview");
      await expect(preview.locator("pre code")).toHaveCount(3);
      await expect(preview.locator("p code")).toHaveText("apt clean");
      await expect(preview.locator("pre code").nth(0)).toHaveText("# Clear cached packages\napt autoremove -y\n");
      await expect(preview.locator("pre code").nth(1)).toHaveText("journalctl --rotate\n");
      await expect(preview.locator("pre code").nth(2)).toHaveText("history -c\n");

      const colors = await preview.locator("code").evaluateAll((elements) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const paint = canvas.getContext("2d")!;
        const luminance = (rgb: Uint8ClampedArray) => {
          const linear = Array.from(rgb.slice(0, 3), (channel) => {
            const value = channel / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          });
          return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
        };

        return elements.map((element) => {
          // Resolve color-mix and composite translucent backgrounds before measuring contrast.
          paint.fillStyle = "white";
          paint.fillRect(0, 0, 1, 1);
          const ancestors: Element[] = [];
          for (let current: Element | null = element; current; current = current.parentElement) {
            ancestors.unshift(current);
          }
          for (const ancestor of ancestors) {
            paint.fillStyle = getComputedStyle(ancestor).backgroundColor;
            paint.fillRect(0, 0, 1, 1);
          }
          const background = luminance(paint.getImageData(0, 0, 1, 1).data);
          paint.fillStyle = getComputedStyle(element).color;
          paint.fillRect(0, 0, 1, 1);
          const foreground = luminance(paint.getImageData(0, 0, 1, 1).data);
          return {
            block: element.parentElement?.tagName === "PRE",
            background,
            contrast: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
          };
        });
      });

      expect(colors).toHaveLength(4);
      for (const color of colors) {
        expect(color.contrast, `${theme} ${color.block ? "block" : "inline"} code contrast`)
          .toBeGreaterThanOrEqual(color.block ? 7 : 4.5);
        if (theme === "midnight" && color.block) {
          expect(color.background, "Midnight code blocks should keep a dark background").toBeLessThan(0.04);
        }
      }
      if (theme === "midnight") {
        await preview.screenshot({ path: test.info().outputPath("midnight-code-preview.png") });
      }
      await editor.getByLabel("Close edit task dialog").click();
      await expect(editor).toHaveCount(0);
    }
  });
}
