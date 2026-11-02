import { expect, test } from "@playwright/test";

test("API docs render the specification and execute the health endpoint", async ({ page }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires the real server in the compose stack.");

  const response = await page.goto("/docs/");

  expect(response?.status()).toBe(200);
  await expect(page.locator(".swagger-ui .info .title")).toContainText("bbtodo API");
  await expect(page.locator(".swagger-ui .errors-wrapper")).toHaveCount(0);

  const healthOperation = page.locator(".opblock").filter({
    has: page.locator(".opblock-summary-path", { hasText: /^\/health$/ })
  });
  await healthOperation.locator(".opblock-summary").click();
  await healthOperation.getByRole("button", { name: "Try it out" }).click();

  const healthResponse = page.waitForResponse(
    (result) => new URL(result.url()).pathname === "/health" && result.request().method() === "GET"
  );
  await healthOperation.getByRole("button", { name: "Execute", exact: true }).click();

  expect(await (await healthResponse).json()).toEqual({ app: "bbtodo-server", status: "ok" });
  await expect(
    healthOperation.locator(".live-responses-table").getByRole("cell", { name: "200", exact: true })
  ).toBeVisible();
  await expect(healthOperation.locator(".live-responses-table")).toContainText('"status": "ok"');
});
