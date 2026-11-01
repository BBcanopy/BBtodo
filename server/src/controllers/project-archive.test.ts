import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { createMutableMockOidcProvider, loginWithOidc, testConfig } from "../test-helpers.js";

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  while (apps.length) {
    await apps.pop()!.close();
  }
});

async function setup() {
  const oidc = createMutableMockOidcProvider({ subject: "owner", email: "owner@example.com", displayName: "Owner" });
  const app = buildApp({ config: testConfig, oidcProvider: oidc.provider, sqlitePath: ":memory:" });
  apps.push(app);
  const session = await loginWithOidc(app);
  const cookies = { bbtodo_session: session.sessionCookie };
  const response = await app.inject({ method: "POST", url: "/api/v1/projects", cookies, payload: { name: "Archive board" } });
  expect(response.statusCode).toBe(201);
  return { app, cookies, oidc, project: response.json() };
}

describe("project archiving", () => {
  it("archives and restores projects without losing tasks, lanes, or ticket links", async () => {
    const { app, cookies, project } = await setup();
    expect(project.archived).toBe(false);
    const projectUrl = `/api/v1/projects/${project.id}`;
    const createdTask = await app.inject({
      method: "POST", url: `${projectUrl}/tasks`, cookies,
      payload: { title: "Keep this task", body: "Original notes", laneId: project.laneSummaries[0].id }
    });
    expect(createdTask.statusCode).toBe(201);
    const task = createdTask.json();
    const beforeTodos = await app.inject({ method: "GET", url: "/api/v1/todos", cookies });
    expect(beforeTodos.json()).toHaveLength(1);

    const archived = await app.inject({ method: "PATCH", url: projectUrl, cookies, payload: { archived: true } });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ archived: true, name: project.name, ticketPrefix: project.ticketPrefix });
    const archivedLanes = archived.json().laneSummaries;
    expect(archivedLanes.map((lane: { id: string }) => lane.id)).toEqual(project.laneSummaries.map((lane: { id: string }) => lane.id));
    for (const query of ["", "?includeArchived=false"]) {
      const list = await app.inject({ method: "GET", url: `/api/v1/projects${query}`, cookies });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual([]);
    }
    const inclusive = await app.inject({ method: "GET", url: "/api/v1/projects?includeArchived=true", cookies });
    expect(inclusive.json()).toEqual([archived.json()]);
    const hiddenTodos = await app.inject({ method: "GET", url: "/api/v1/todos", cookies });
    expect(hiddenTodos.json()).toEqual([]);

    const direct = await app.inject({ method: "GET", url: `/api/v1/projects/by-ticket-prefix/${project.ticketPrefix}`, cookies });
    expect(direct.statusCode).toBe(200);
    expect(direct.json()).toEqual(archived.json());
    const directTask = await app.inject({ method: "GET", url: `/api/v1/tasks/by-ticket/${task.ticketId}`, cookies });
    expect(directTask.json()).toEqual(task);
    const edited = await app.inject({ method: "PATCH", url: `${projectUrl}/tasks/${task.id}`, cookies, payload: { title: "Still editable" } });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ id: task.id, ticketId: task.ticketId, title: "Still editable", body: task.body });
    const renamed = await app.inject({ method: "PATCH", url: projectUrl, cookies, payload: { name: "Renamed archive" } });
    expect(renamed.json()).toMatchObject({ archived: true, name: "Renamed archive" });

    const restored = await app.inject({ method: "PATCH", url: projectUrl, cookies, payload: { name: "Restored board", archived: false } });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ id: project.id, archived: false, name: "Restored board", ticketPrefix: project.ticketPrefix });
    expect(restored.json().laneSummaries).toEqual(archivedLanes);
    const active = await app.inject({ method: "GET", url: "/api/v1/projects", cookies });
    expect(active.json()).toEqual([restored.json()]);
    const restoredTodos = await app.inject({ method: "GET", url: "/api/v1/todos", cookies });
    expect(restoredTodos.json()[0]).toMatchObject({ projectId: project.id, projectName: "Restored board", tasks: [edited.json()] });
  });

  it("rejects invalid archive updates and list flags without changing a project", async () => {
    const { app, cookies, project } = await setup();
    for (const payload of [{}, { archived: "true" }, { archived: null }, { archived: 1 }, { name: " " }, { unknown: true }]) {
      const response = await app.inject({ method: "PATCH", url: `/api/v1/projects/${project.id}`, cookies, payload });
      expect(response.statusCode).toBe(400);
    }
    const invalidQuery = await app.inject({ method: "GET", url: "/api/v1/projects?includeArchived=anything", cookies });
    expect(invalidQuery.statusCode).toBe(400);
    const list = await app.inject({ method: "GET", url: "/api/v1/projects", cookies });
    expect(list.json()).toEqual([project]);
  });

  it("requires authentication and ownership for archive and restore, including inclusive lists", async () => {
    const { app, cookies, oidc, project } = await setup();
    const projectUrl = `/api/v1/projects/${project.id}`;
    const anonymous = await app.inject({ method: "PATCH", url: projectUrl, payload: { archived: true } });
    expect(anonymous.statusCode).toBe(401);
    const tokenResponse = await app.inject({ method: "POST", url: "/api/v1/api-tokens", cookies, payload: { name: "Archive automation" } });
    const headers = { authorization: `Bearer ${tokenResponse.json().token}` };
    const archived = await app.inject({ method: "PATCH", url: projectUrl, headers, payload: { archived: true } });
    expect(archived.statusCode).toBe(200);
    const tokenList = await app.inject({ method: "GET", url: "/api/v1/projects?includeArchived=true", headers });
    expect(tokenList.json()).toEqual([archived.json()]);

    oidc.setIdentity({ subject: "other", email: "other@example.com", displayName: "Other" });
    const otherSession = await loginWithOidc(app);
    const otherCookies = { bbtodo_session: otherSession.sessionCookie };
    for (const archived of [false, true]) {
      const forbidden = await app.inject({ method: "PATCH", url: projectUrl, cookies: otherCookies, payload: { archived } });
      expect(forbidden.statusCode).toBe(404);
    }
    const otherList = await app.inject({ method: "GET", url: "/api/v1/projects?includeArchived=true", cookies: otherCookies });
    expect(otherList.json()).toEqual([]);
    const missing = await app.inject({ method: "PATCH", url: "/api/v1/projects/00000000-0000-4000-8000-000000000000", cookies, payload: { archived: true } });
    expect(missing.statusCode).toBe(404);
  });
});
