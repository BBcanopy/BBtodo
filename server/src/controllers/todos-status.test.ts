import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.js";
import { createMutableMockOidcProvider, loginWithOidc, testConfig } from "../test-helpers.js";

const apps: ReturnType<typeof buildApp>[] = [];
type Project = { id: string; laneSummaries: { id: string; name: string }[] };

afterEach(async () => {
  vi.useRealTimers();
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
  async function createProject(name: string) {
    const response = await app.inject({ method: "POST", url: "/api/v1/projects", cookies, payload: { name } });
    expect(response.statusCode).toBe(201);
    return response.json<Project>();
  }
  async function createTask(project: Project, laneName: string, title: string, parentTaskId?: string) {
    const laneId = project.laneSummaries.find((lane) => lane.name === laneName)!.id;
    const response = await app.inject({
      method: "POST", url: `/api/v1/projects/${project.id}/tasks`, cookies,
      payload: { laneId, title, parentTaskId }
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>();
  }
  async function list(status?: string) {
    const query = status === undefined ? "" : `?${new URLSearchParams({ status })}`;
    return app.inject({ method: "GET", url: `/api/v1/todos${query}`, cookies });
  }
  return { app, cookies, createProject, createTask, list, oidc };
}

describe("grouped tasks by status", () => {
  it("keeps the Todo default and filters every standard status across boards", async () => {
    const { createProject, createTask, list } = await setup();
    const first = await createProject("First board");
    const second = await createProject("Second board");
    for (const project of [first, second]) {
      for (const lane of project.laneSummaries) {
        await createTask(project, lane.name, `${lane.name} task`);
      }
    }
    const defaultResponse = await list();
    expect(defaultResponse.statusCode).toBe(200);
    expect(defaultResponse.json()).toEqual((await list("Todo")).json());
    for (const lane of first.laneSummaries) {
      const response = await list(lane.name);
      expect(response.statusCode).toBe(200);
      const groups = response.json<{ projectId: string; tasks: { title: string }[] }[]>();
      expect(groups).toHaveLength(2);
      expect(new Set(groups.map((group) => group.projectId))).toEqual(new Set([first.id, second.id]));
      expect(groups.every((group) => group.tasks.length === 1 && group.tasks[0].title === `${lane.name} task`)).toBe(true);
    }
    expect((await list("  IN   PROGRESS  ")).json()).toEqual((await list("In Progress")).json());
  });

  it("includes normalized custom lanes, duplicate names, and preserves parent/subtask order", async () => {
    const { app, cookies, createProject, createTask, list } = await setup();
    const project = await createProject("Custom board");
    const ids: string[] = [];
    for (const name of ["Ready  for QA", "ready for qa"]) {
      const response = await app.inject({
        method: "POST", url: `/api/v1/projects/${project.id}/lanes`, cookies, payload: { name }
      });
      expect(response.statusCode).toBe(201);
      project.laneSummaries.push(response.json());
      const parent = await createTask(project, name, `${name} parent`);
      const child = await createTask(project, name, `${name} child`, parent.id);
      ids.push(parent.id, child.id);
    }
    const response = await list(" READY   FOR qa ");
    expect(response.statusCode).toBe(200);
    expect(response.json()[0].tasks.map((task: { id: string }) => task.id)).toEqual(ids);
    expect((await list("Unknown status")).json()).toEqual([]);
    expect((await list("Done")).json()).toEqual([]);
  });

  it("retains newest-first Done ordering", async () => {
    const { createProject, createTask, list } = await setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T10:00:00Z"));
    const project = await createProject("Done board");
    const older = await createTask(project, "Done", "Older done task");
    vi.setSystemTime(new Date("2026-11-04T11:00:00Z"));
    const newer = await createTask(project, "Done", "Newer done task");
    const child = await createTask(project, "Done", "Done child", newer.id);
    expect((await list("done")).json()[0].tasks.map((task: { id: string }) => task.id)).toEqual([
      newer.id, child.id, older.id
    ]);
  });

  it("excludes archived boards and other owners and requires authentication", async () => {
    const { app, cookies, createProject, createTask, list, oidc } = await setup();
    const project = await createProject("Private board");
    await createTask(project, "Done", "Private done task");
    expect((await list("Done")).json()).toHaveLength(1);
    const archived = await app.inject({
      method: "PATCH", url: `/api/v1/projects/${project.id}`, cookies, payload: { archived: true }
    });
    expect(archived.statusCode).toBe(200);
    expect((await list("Done")).json()).toEqual([]);
    await app.inject({ method: "PATCH", url: `/api/v1/projects/${project.id}`, cookies, payload: { archived: false } });
    oidc.setIdentity({ subject: "other", email: "other@example.com", displayName: "Other" });
    const other = await loginWithOidc(app);
    const otherResponse = await app.inject({
      method: "GET", url: "/api/v1/todos?status=Done", cookies: { bbtodo_session: other.sessionCookie }
    });
    expect(otherResponse.statusCode).toBe(200);
    expect(otherResponse.json()).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/v1/todos?status=Done" })).statusCode).toBe(401);
  });

  it("validates one nonempty status up to 80 characters and documents the query", async () => {
    const { app, cookies, list } = await setup();
    for (const status of ["", "   ", "x".repeat(81)]) {
      expect((await list(status)).statusCode).toBe(400);
    }
    expect((await list("x".repeat(80))).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/todos?status=Todo&status=Done", cookies })).statusCode).toBe(400);
    const docs = await app.inject({ method: "GET", url: "/docs/openapi.json" });
    expect(docs.statusCode).toBe(200);
    expect(docs.json().paths["/api/v1/todos"].get.parameters).toContainEqual(expect.objectContaining({
      name: "status", in: "query", required: false,
      schema: expect.objectContaining({ type: "string", minLength: 1, maxLength: 80, default: "Todo" })
    }));
  });
});
