import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.js";
import {
  createMutableMockOidcProvider,
  loginWithOidc,
  testConfig
} from "../test-helpers.js";

const createdApps: ReturnType<typeof buildApp>[] = [];
const tag = (label: string, color: "amber" | "coral" | "moss" | "orchid" | "sky" | "slate" = "moss") => ({
  color,
  label
});

afterEach(async () => {
  vi.useRealTimers();
  while (createdApps.length > 0) {
    const app = createdApps.pop();
    if (app) {
      await app.close();
    }
  }
});

describe("projects and tasks API", () => {
  it("ignores duplicate task content updates without changing task or project timestamps", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let now = Date.parse("2026-10-31T12:00:00.000Z");
    vi.setSystemTime(now);
    const oidc = createMutableMockOidcProvider({
      subject: "user-1",
      email: "one@example.com",
      displayName: "User One"
    });
    const app = buildApp({ config: testConfig, oidcProvider: oidc.provider, sqlitePath: ":memory:" });
    createdApps.push(app);
    const session = await loginWithOidc(app);
    const cookies = { bbtodo_session: session.sessionCookie };
    const projectResponse = await app.inject({
      method: "POST", url: "/api/v1/projects", cookies, payload: { name: "Autosave board" }
    });
    const project = projectResponse.json();
    const taskResponse = await app.inject({
      method: "POST", url: `/api/v1/projects/${project.id}/tasks`, cookies,
      payload: { title: "Review retries", body: "Initial body", tags: [tag("backend", "sky"), tag("retry")] }
    });
    expect(taskResponse.statusCode).toBe(201);
    let task = taskResponse.json();
    const taskUrl = `/api/v1/projects/${project.id}/tasks/${task.id}`;

    for (const [index, change] of [
      { title: "Review retries" },
      { title: "Review final retries" },
      { body: "Updated body" },
      { tags: [tag("backend", "coral"), tag("retry")] },
      { tags: [tag("backend", "coral"), tag("rollout")] },
      { tags: [tag("rollout"), tag("backend", "coral")] },
      { tags: [] }
    ].entries()) {
      now += 1000;
      vi.setSystemTime(now);
      const updateResponse = await app.inject({ method: "PATCH", url: taskUrl, cookies, payload: change });
      expect(updateResponse.statusCode).toBe(200);
      const updatedTask = updateResponse.json();
      if (index > 0) {
        expect(updatedTask.updatedAt).toBe(new Date(now).toISOString());
        expect(updatedTask.updatedAt).not.toBe(task.updatedAt);
      } else {
        expect(updatedTask).toEqual(task);
      }
      task = updatedTask;
      const projectsBeforeDuplicate = await app.inject({ method: "GET", url: "/api/v1/projects", cookies });

      now += 1000;
      vi.setSystemTime(now);
      const duplicateResponse = await app.inject({
        method: "PATCH", url: taskUrl, cookies,
        payload: {
          body: task.body,
          tags: task.tags.map((taskTag: { color: string; label: string }) => ({
            ...taskTag, label: `  ${taskTag.label}  `
          })),
          title: `  ${task.title}  `
        }
      });
      expect(duplicateResponse.statusCode).toBe(200);
      expect(duplicateResponse.json()).toEqual(task);
      const projectsAfterDuplicate = await app.inject({ method: "GET", url: "/api/v1/projects", cookies });
      expect(projectsAfterDuplicate.json()).toEqual(projectsBeforeDuplicate.json());
    }
  });

  it("lists todo-lane tasks across projects grouped by board", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "user-1",
      email: "one@example.com",
      displayName: "User One"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);

    const createFirstProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Billing cleanup"
      }
    });
    const firstProject = createFirstProjectResponse.json();

    const createSecondProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Partner audit"
      }
    });
    const secondProject = createSecondProjectResponse.json();

    const createTodoParentResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${firstProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Review retry settings",
        tags: [tag("backend", "sky")]
      }
    });
    const todoParentTask = createTodoParentResponse.json();

    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${firstProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Queue copy pass",
        tags: [tag("copy")]
      }
    });

    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${firstProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        parentTaskId: todoParentTask.id,
        title: "Capture callback evidence",
        tags: [tag("retry", "coral")]
      }
    });

    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${firstProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        laneId: firstProject.laneSummaries[1].id,
        title: "Already in progress"
      }
    });

    const createSecondProjectTodoResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${secondProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Check partner scope",
        tags: [tag("partner", "orchid")]
      }
    });
    const secondProjectTodoTask = createSecondProjectTodoResponse.json();

    const listTodosResponse = await app.inject({
      method: "GET",
      url: "/api/v1/todos",
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(listTodosResponse.statusCode).toBe(200);
    expect(listTodosResponse.json()).toEqual([
      {
        projectId: secondProject.id,
        projectName: "Partner audit",
        projectTicketPrefix: "PART",
        tasks: [
          expect.objectContaining({
            id: secondProjectTodoTask.id,
            ticketId: "PART-1",
            title: "Check partner scope"
          })
        ]
      },
      {
        projectId: firstProject.id,
        projectName: "Billing cleanup",
        projectTicketPrefix: "BILL",
        tasks: [
          expect.objectContaining({
            parentTaskId: null,
            ticketId: "BILL-1",
            title: "Review retry settings"
          }),
          expect.objectContaining({
            parentTaskId: todoParentTask.id,
            ticketId: "BILL-3",
            title: "Capture callback evidence"
          }),
          expect.objectContaining({
            parentTaskId: null,
            ticketId: "BILL-2",
            title: "Queue copy pass"
          })
        ]
      }
    ]);
  });

  it("requires auth to list grouped todos", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "user-1",
      email: "one@example.com",
      displayName: "User One"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/todos"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      message: "Authentication required."
    });
  });

  it("supports the full project and task lifecycle", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "user-1",
      email: "one@example.com",
      displayName: "User One"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);

    const createProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Launch board"
      }
    });

    expect(createProjectResponse.statusCode).toBe(201);
    const project = createProjectResponse.json();
    expect(project.ticketPrefix).toBe("LAUN");
    expect(project.laneSummaries.map((lane: { name: string }) => lane.name)).toEqual([
      "Todo",
      "In Progress",
      "In review",
      "Done"
    ]);

    const listProjectsResponse = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(listProjectsResponse.statusCode).toBe(200);
    expect(listProjectsResponse.json()).toEqual([project]);

    const updateProjectResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Launch board v2"
      }
    });

    expect(updateProjectResponse.statusCode).toBe(200);
    expect(updateProjectResponse.json()).toMatchObject({
      id: project.id,
      name: "Launch board v2",
      ticketPrefix: "LAUN"
    });

    const createTaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Write the first task",
        tags: [tag("launch", "sky"), tag("api", "amber")]
      }
    });

    expect(createTaskResponse.statusCode).toBe(201);
    expect(createTaskResponse.json()).toMatchObject({
      body: "",
      laneId: project.laneSummaries[0].id,
      projectId: project.id,
      position: 0,
      ticketId: "LAUN-1",
      tags: [tag("launch", "sky"), tag("api", "amber")],
      title: "Write the first task"
    });

    const task = createTaskResponse.json();
    const inProgressLane = project.laneSummaries[1];

    const updateTaskResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/tasks/${task.id}`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        laneId: inProgressLane.id,
        tags: [tag("backend", "coral"), tag("launch", "sky")]
      }
    });

    expect(updateTaskResponse.statusCode).toBe(200);
    expect(updateTaskResponse.json()).toMatchObject({
      id: task.id,
      laneId: inProgressLane.id,
      ticketId: "LAUN-1",
      tags: [tag("backend", "coral"), tag("launch", "sky")]
    });

    const updatedProjectsResponse = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(updatedProjectsResponse.statusCode).toBe(200);
    expect(updatedProjectsResponse.json()).toHaveLength(1);
    expect(updatedProjectsResponse.json()[0]).toMatchObject({
      id: project.id,
      name: "Launch board v2",
      ticketPrefix: "LAUN"
    });
    expect(updatedProjectsResponse.json()[0].laneSummaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: inProgressLane.id,
          taskCount: 1
        })
      ])
    );

    const listedTasksResponse = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(listedTasksResponse.statusCode).toBe(200);
    expect(listedTasksResponse.json()).toHaveLength(1);
    expect(listedTasksResponse.json()[0]).toMatchObject({
      id: task.id,
      laneId: inProgressLane.id,
      ticketId: "LAUN-1",
      tags: [tag("backend", "coral"), tag("launch", "sky")]
    });

    const deleteTaskResponse = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${project.id}/tasks/${task.id}`,
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(deleteTaskResponse.statusCode).toBe(204);

    const deleteProjectResponse = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${project.id}`,
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(deleteProjectResponse.statusCode).toBe(204);

    const afterDeleteListResponse = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(afterDeleteListResponse.statusCode).toBe(200);
    expect(afterDeleteListResponse.json()).toEqual([]);
  });

  it("keeps project prefixes frozen and task ticket ids stable across renames and subtasks", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "user-1",
      email: "one@example.com",
      displayName: "User One"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);

    const createProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Billing cleanup"
      }
    });
    expect(createProjectResponse.statusCode).toBe(201);
    const project = createProjectResponse.json();

    const createParentTaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Parent task"
      }
    });
    expect(createParentTaskResponse.statusCode).toBe(201);
    expect(createParentTaskResponse.json()).toMatchObject({
      ticketId: "BILL-1",
      title: "Parent task"
    });
    const parentTask = createParentTaskResponse.json();

    const createSubtaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        parentTaskId: parentTask.id,
        title: "Child task"
      }
    });
    expect(createSubtaskResponse.statusCode).toBe(201);
    expect(createSubtaskResponse.json()).toMatchObject({
      parentTaskId: parentTask.id,
      ticketId: "BILL-2",
      title: "Child task"
    });

    const renameProjectResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Operations board"
      }
    });
    expect(renameProjectResponse.statusCode).toBe(200);

    const createPostRenameTaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Post rename task"
      }
    });
    expect(createPostRenameTaskResponse.statusCode).toBe(201);
    expect(createPostRenameTaskResponse.json()).toMatchObject({
      ticketId: "BILL-3",
      title: "Post rename task"
    });

    const moveParentTaskResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/tasks/${parentTask.id}`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        laneId: project.laneSummaries[1].id
      }
    });
    expect(moveParentTaskResponse.statusCode).toBe(200);
    expect(moveParentTaskResponse.json()).toMatchObject({
      id: parentTask.id,
      ticketId: "BILL-1"
    });
  });

  it("moves a top-level task with subtasks to another project and allocates destination ticket ids", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "user-1",
      email: "one@example.com",
      displayName: "User One"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);

    const createSourceProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Release prep"
      }
    });
    expect(createSourceProjectResponse.statusCode).toBe(201);
    const sourceProject = createSourceProjectResponse.json();

    const createDestinationProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Roadmap review"
      }
    });
    expect(createDestinationProjectResponse.statusCode).toBe(201);
    const destinationProject = createDestinationProjectResponse.json();

    const sourceInProgressLane = sourceProject.laneSummaries[1];
    const destinationInProgressLane = destinationProject.laneSummaries[1];

    const existingDestinationTaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${destinationProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        laneId: destinationInProgressLane.id,
        title: "Existing destination task"
      }
    });
    expect(existingDestinationTaskResponse.statusCode).toBe(201);

    const createParentTaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${sourceProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        laneId: sourceInProgressLane.id,
        title: "Move release checklist"
      }
    });
    expect(createParentTaskResponse.statusCode).toBe(201);
    const parentTask = createParentTaskResponse.json();

    const createFirstChildResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${sourceProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        parentTaskId: parentTask.id,
        title: "Update launch notes"
      }
    });
    expect(createFirstChildResponse.statusCode).toBe(201);
    const firstChildTask = createFirstChildResponse.json();

    const createSecondChildResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${sourceProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        parentTaskId: parentTask.id,
        title: "Confirm rollout owners"
      }
    });
    expect(createSecondChildResponse.statusCode).toBe(201);
    const secondChildTask = createSecondChildResponse.json();

    const moveTaskResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${sourceProject.id}/tasks/${parentTask.id}`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        destinationProjectId: destinationProject.id
      }
    });

    expect(moveTaskResponse.statusCode).toBe(200);
    expect(moveTaskResponse.json()).toMatchObject({
      id: parentTask.id,
      laneId: destinationInProgressLane.id,
      parentTaskId: null,
      projectId: destinationProject.id,
      ticketId: "ROAD-2",
      title: "Move release checklist"
    });

    const sourceTasksResponse = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${sourceProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });
    expect(sourceTasksResponse.statusCode).toBe(200);
    expect(sourceTasksResponse.json()).toEqual([]);

    const destinationTasksResponse = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${destinationProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(destinationTasksResponse.statusCode).toBe(200);
    expect(
      destinationTasksResponse.json().map((task: { id: string; ticketId: string }) => ({
        id: task.id,
        ticketId: task.ticketId
      }))
    ).toEqual([
      {
        id: existingDestinationTaskResponse.json().id,
        ticketId: "ROAD-1"
      },
      {
        id: parentTask.id,
        ticketId: "ROAD-2"
      },
      {
        id: firstChildTask.id,
        ticketId: "ROAD-3"
      },
      {
        id: secondChildTask.id,
        ticketId: "ROAD-4"
      }
    ]);
    expect(destinationTasksResponse.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: firstChildTask.id,
          laneId: destinationInProgressLane.id,
          parentTaskId: parentTask.id,
          projectId: destinationProject.id,
          ticketId: "ROAD-3"
        }),
        expect.objectContaining({
          id: secondChildTask.id,
          laneId: destinationInProgressLane.id,
          parentTaskId: parentTask.id,
          projectId: destinationProject.id,
          ticketId: "ROAD-4"
        })
      ])
    );
  });

  it("promotes a moved subtask to a top-level task in the destination project", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "user-1",
      email: "one@example.com",
      displayName: "User One"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);

    const createSourceProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Billing cleanup"
      }
    });
    expect(createSourceProjectResponse.statusCode).toBe(201);
    const sourceProject = createSourceProjectResponse.json();

    const createDestinationProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Partner audit"
      }
    });
    expect(createDestinationProjectResponse.statusCode).toBe(201);
    const destinationProject = createDestinationProjectResponse.json();

    const parentTaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${sourceProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Prepare billing updates"
      }
    });
    expect(parentTaskResponse.statusCode).toBe(201);
    const parentTask = parentTaskResponse.json();

    const movedChildResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${sourceProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        parentTaskId: parentTask.id,
        title: "Draft changelog"
      }
    });
    expect(movedChildResponse.statusCode).toBe(201);
    const movedChild = movedChildResponse.json();

    const remainingChildResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${sourceProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        parentTaskId: parentTask.id,
        title: "Review support notes"
      }
    });
    expect(remainingChildResponse.statusCode).toBe(201);
    const remainingChild = remainingChildResponse.json();

    const moveTaskResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${sourceProject.id}/tasks/${movedChild.id}`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        destinationProjectId: destinationProject.id
      }
    });

    expect(moveTaskResponse.statusCode).toBe(200);
    expect(moveTaskResponse.json()).toMatchObject({
      id: movedChild.id,
      laneId: destinationProject.laneSummaries[0].id,
      parentTaskId: null,
      projectId: destinationProject.id,
      ticketId: "PART-1",
      title: "Draft changelog"
    });

    const sourceTasksResponse = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${sourceProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });
    expect(sourceTasksResponse.statusCode).toBe(200);
    expect(sourceTasksResponse.json()).toEqual([
      expect.objectContaining({
        id: parentTask.id,
        parentTaskId: null,
        position: 0,
        ticketId: "BILL-1"
      }),
      expect.objectContaining({
        id: remainingChild.id,
        parentTaskId: parentTask.id,
        position: 0,
        ticketId: "BILL-3"
      })
    ]);

    const destinationTasksResponse = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${destinationProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });
    expect(destinationTasksResponse.statusCode).toBe(200);
    expect(destinationTasksResponse.json()).toEqual([
      expect.objectContaining({
        id: movedChild.id,
        laneId: destinationProject.laneSummaries[0].id,
        parentTaskId: null,
        position: 0,
        projectId: destinationProject.id,
        ticketId: "PART-1"
      })
    ]);
  });

  it("looks up a task by ticket id for the current user", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "user-1",
      email: "one@example.com",
      displayName: "User One"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);

    const createProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Lookup board"
      }
    });
    const project = createProjectResponse.json();

    const createTaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        body: "Resolve me by ticket id",
        title: "Lookup target",
        tags: [tag("api", "amber")]
      }
    });
    expect(createTaskResponse.statusCode).toBe(201);
    const createdTask = createTaskResponse.json();

    const lookupResponse = await app.inject({
      method: "GET",
      url: `/api/v1/tasks/by-ticket/${createdTask.ticketId}`,
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(lookupResponse.statusCode).toBe(200);
    expect(lookupResponse.json()).toMatchObject({
      body: "Resolve me by ticket id",
      id: createdTask.id,
      projectId: project.id,
      tags: [tag("api", "amber")],
      ticketId: createdTask.ticketId,
      title: "Lookup target"
    });
  });

  it("resolves projects by ticket prefix for the owning user", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "user-1",
      email: "one@example.com",
      displayName: "User One"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);

    const createProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Lookup board"
      }
    });
    expect(createProjectResponse.statusCode).toBe(201);
    const project = createProjectResponse.json();

    const lookupResponse = await app.inject({
      method: "GET",
      url: `/api/v1/projects/by-ticket-prefix/${project.ticketPrefix}`,
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(lookupResponse.statusCode).toBe(200);
    expect(lookupResponse.json()).toMatchObject({
      id: project.id,
      name: "Lookup board",
      ticketPrefix: project.ticketPrefix
    });
    expect(lookupResponse.json().laneSummaries.map((lane: { name: string }) => lane.name)).toEqual([
      "Todo",
      "In Progress",
      "In review",
      "Done"
    ]);
  });

  it("returns 404 when a project prefix lookup misses", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "user-1",
      email: "one@example.com",
      displayName: "User One"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);

    const lookupResponse = await app.inject({
      method: "GET",
      url: "/api/v1/projects/by-ticket-prefix/LOOK",
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(lookupResponse.statusCode).toBe(404);
    expect(lookupResponse.json()).toEqual({
      message: "Project not found."
    });
  });

  it("rejects invalid project prefix formats on lookup", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "user-1",
      email: "one@example.com",
      displayName: "User One"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);

    const lookupResponse = await app.inject({
      method: "GET",
      url: "/api/v1/projects/by-ticket-prefix/look-1",
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(lookupResponse.statusCode).toBe(400);
  });

  it("returns 404 when a ticket lookup misses", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "user-1",
      email: "one@example.com",
      displayName: "User One"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);

    const lookupResponse = await app.inject({
      method: "GET",
      url: "/api/v1/tasks/by-ticket/LOOK-99",
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(lookupResponse.statusCode).toBe(404);
    expect(lookupResponse.json()).toEqual({
      message: "Task not found."
    });
  });

  it("rejects invalid ticket id formats on lookup", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "user-1",
      email: "one@example.com",
      displayName: "User One"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);

    const lookupResponse = await app.inject({
      method: "GET",
      url: "/api/v1/tasks/by-ticket/look-0",
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(lookupResponse.statusCode).toBe(400);
  });

  it("falls back for non-letter names and exhausted name-derived prefixes while resolving collisions", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "user-1",
      email: "one@example.com",
      displayName: "User One"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);

    const numericOnlyProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "12345"
      }
    });
    expect(numericOnlyProjectResponse.statusCode).toBe(201);
    const numericOnlyProject = numericOnlyProjectResponse.json();

    const numericOnlyTaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${numericOnlyProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Fallback prefix task"
      }
    });
    expect(numericOnlyTaskResponse.statusCode).toBe(201);
    expect(numericOnlyTaskResponse.json()).toMatchObject({
      title: "Fallback prefix task"
    });
    expect(numericOnlyTaskResponse.json().ticketId).toMatch(/^[A-Z]{4}-1$/);

    const firstCollidingProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Bill"
      }
    });
    expect(firstCollidingProjectResponse.statusCode).toBe(201);
    const firstProject = firstCollidingProjectResponse.json();

    const secondCollidingProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Billiards backlog"
      }
    });
    expect(secondCollidingProjectResponse.statusCode).toBe(201);
    const secondProject = secondCollidingProjectResponse.json();

    const secondProjectTaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${secondProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Different collision candidate"
      }
    });
    expect(secondProjectTaskResponse.statusCode).toBe(201);
    expect(secondProjectTaskResponse.json()).toMatchObject({
      ticketId: "BILI-1"
    });

    const singleLetterProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Q"
      }
    });
    expect(singleLetterProjectResponse.statusCode).toBe(201);

    const fallbackAfterNameExhaustionResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Q"
      }
    });
    expect(fallbackAfterNameExhaustionResponse.statusCode).toBe(201);
    const fallbackAfterNameExhaustionProject = fallbackAfterNameExhaustionResponse.json();

    const fallbackAfterNameExhaustionTaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${fallbackAfterNameExhaustionProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Fallback after collision"
      }
    });
    expect(fallbackAfterNameExhaustionTaskResponse.statusCode).toBe(201);
    expect(fallbackAfterNameExhaustionTaskResponse.json().ticketId).toMatch(/^[A-Z]{4}-1$/);

    const firstProjectTaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${firstProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Original collision candidate"
      }
    });
    expect(firstProjectTaskResponse.statusCode).toBe(201);
    expect(firstProjectTaskResponse.json()).toMatchObject({
      ticketId: "BILL-1"
    });
  });

  it("supports one-level subtasks and promotes them when a parent is deleted", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "user-1",
      email: "one@example.com",
      displayName: "User One"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);

    const createProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Subtask board"
      }
    });
    const project = createProjectResponse.json();
    const todoLane = project.laneSummaries[0];
    const inProgressLane = project.laneSummaries[1];

    const parentTaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Parent task"
      }
    });
    const siblingTaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Sibling task"
      }
    });

    const parentTask = parentTaskResponse.json();
    const siblingTask = siblingTaskResponse.json();

    const createSubtaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Child task",
        parentTaskId: parentTask.id
      }
    });

    expect(createSubtaskResponse.statusCode).toBe(201);
    const childTask = createSubtaskResponse.json();
    expect(childTask).toMatchObject({
      laneId: todoLane.id,
      parentTaskId: parentTask.id,
      position: 0,
      title: "Child task"
    });

    const nestedSubtaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Too deep",
        parentTaskId: childTask.id
      }
    });

    expect(nestedSubtaskResponse.statusCode).toBe(400);

    const moveChildToParentLaneResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/tasks/${siblingTask.id}`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        parentTaskId: parentTask.id
      }
    });

    expect(moveChildToParentLaneResponse.statusCode).toBe(200);
    expect(moveChildToParentLaneResponse.json()).toMatchObject({
      laneId: todoLane.id,
      parentTaskId: parentTask.id,
      position: 1
    });

    const moveParentResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/tasks/${parentTask.id}`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        laneId: inProgressLane.id
      }
    });

    expect(moveParentResponse.statusCode).toBe(200);
    expect(moveParentResponse.json()).toMatchObject({
      laneId: inProgressLane.id,
      parentTaskId: null
    });

    const listedTasksResponse = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(listedTasksResponse.statusCode).toBe(200);
    expect(listedTasksResponse.json()).toEqual([
      expect.objectContaining({
        id: parentTask.id,
        laneId: inProgressLane.id,
        parentTaskId: null,
        position: 0
      }),
      expect.objectContaining({
        id: childTask.id,
        laneId: inProgressLane.id,
        parentTaskId: parentTask.id,
        position: 0
      }),
      expect.objectContaining({
        id: siblingTask.id,
        laneId: inProgressLane.id,
        parentTaskId: parentTask.id,
        position: 1
      })
    ]);

    const projectSummaryResponse = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(projectSummaryResponse.statusCode).toBe(200);
    expect(projectSummaryResponse.json()[0].laneSummaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: todoLane.id, taskCount: 0 }),
        expect.objectContaining({ id: inProgressLane.id, taskCount: 3 })
      ])
    );

    const invalidParentMoveResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/tasks/${parentTask.id}`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        parentTaskId: childTask.id
      }
    });

    expect(invalidParentMoveResponse.statusCode).toBe(400);

    const deleteParentResponse = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${project.id}/tasks/${parentTask.id}`,
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(deleteParentResponse.statusCode).toBe(204);

    const tasksAfterDeleteResponse = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(tasksAfterDeleteResponse.statusCode).toBe(200);
    expect(tasksAfterDeleteResponse.json()).toEqual([
      expect.objectContaining({
        id: childTask.id,
        laneId: inProgressLane.id,
        parentTaskId: null,
        position: 0
      }),
      expect.objectContaining({
        id: siblingTask.id,
        laneId: inProgressLane.id,
        parentTaskId: null,
        position: 1
      })
    ]);
  });

  it("unnests a subtask when a lane-only move omits parentTaskId", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "user-1",
      email: "one@example.com",
      displayName: "User One"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);

    const createProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Lane-only move board"
      }
    });
    const project = createProjectResponse.json();
    const todoLane = project.laneSummaries[0];
    const inProgressLane = project.laneSummaries[1];

    const parentTaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Parent task"
      }
    });
    const childTaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Child task",
        parentTaskId: parentTaskResponse.json().id
      }
    });

    const childTask = childTaskResponse.json();

    const moveChildResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/tasks/${childTask.id}`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        laneId: inProgressLane.id,
        position: 0
      }
    });

    expect(moveChildResponse.statusCode).toBe(200);
    expect(moveChildResponse.json()).toMatchObject({
      id: childTask.id,
      laneId: inProgressLane.id,
      parentTaskId: null,
      position: 0
    });

    const listedTasksResponse = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(listedTasksResponse.statusCode).toBe(200);
    expect(listedTasksResponse.json()).toEqual([
      expect.objectContaining({
        id: parentTaskResponse.json().id,
        laneId: todoLane.id,
        parentTaskId: null,
        position: 0
      }),
      expect.objectContaining({
        id: childTask.id,
        laneId: inProgressLane.id,
        parentTaskId: null,
        position: 0
      })
    ]);
  });

  it("lists reusable tags across the user's projects", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "user-1",
      email: "one@example.com",
      displayName: "User One"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);

    const firstProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Marketing board"
      }
    });
    const secondProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Website board"
      }
    });

    const firstProject = firstProjectResponse.json();
    const secondProject = secondProjectResponse.json();

    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${firstProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Plan Q2 work",
        tags: [tag("strategy", "sky"), tag("shared", "moss")]
      }
    });

    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${secondProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Refresh homepage",
        tags: [tag("design", "amber"), tag("shared", "moss")]
      }
    });

    const taskTagsResponse = await app.inject({
      method: "GET",
      url: "/api/v1/task-tags",
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(taskTagsResponse.statusCode).toBe(200);
    expect(taskTagsResponse.json()).toEqual([
      tag("design", "amber"),
      tag("shared", "moss"),
      tag("strategy", "sky")
    ]);
  });

  it("updates the shared color for existing tags across the user's tasks", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "user-1",
      email: "one@example.com",
      displayName: "User One"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);

    const firstProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Platform board"
      }
    });
    const secondProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Marketing board"
      }
    });

    const firstProject = firstProjectResponse.json();
    const secondProject = secondProjectResponse.json();

    const firstTaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${firstProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Instrument callbacks",
        tags: [tag("backend", "sky")]
      }
    });
    const secondTaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${secondProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Sync launch copy",
        tags: [tag("backend", "sky"), tag("shared", "moss")]
      }
    });

    const firstTask = firstTaskResponse.json();
    const secondTask = secondTaskResponse.json();

    const updateTaskResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${firstProject.id}/tasks/${firstTask.id}`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        tags: [tag("backend", "amber")]
      }
    });

    expect(updateTaskResponse.statusCode).toBe(200);
    expect(updateTaskResponse.json()).toMatchObject({
      id: firstTask.id,
      tags: [tag("backend", "amber")]
    });

    const secondProjectTasksResponse = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${secondProject.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(secondProjectTasksResponse.statusCode).toBe(200);
    expect(secondProjectTasksResponse.json()).toHaveLength(1);
    expect(secondProjectTasksResponse.json()[0]).toMatchObject({
      id: secondTask.id,
      tags: [tag("backend", "amber"), tag("shared", "moss")]
    });

    const taskTagsResponse = await app.inject({
      method: "GET",
      url: "/api/v1/task-tags",
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(taskTagsResponse.statusCode).toBe(200);
    expect(taskTagsResponse.json()).toEqual([
      tag("backend", "amber"),
      tag("shared", "moss")
    ]);
  });

  it("isolates projects and tasks between users and exposes OpenAPI", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "owner",
      email: "owner@example.com",
      displayName: "Owner"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const ownerSession = await loginWithOidc(app);

    const createProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: ownerSession.sessionCookie
      },
      payload: {
        name: "Private board"
      }
    });

    const project = createProjectResponse.json();

    const createTaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: ownerSession.sessionCookie
      },
      payload: {
        title: "Owner-only tag seed",
        tags: [tag("private", "slate")]
      }
    });

    expect(createTaskResponse.statusCode).toBe(201);
    const ownerTask = createTaskResponse.json();

    oidc.setIdentity({
      subject: "other-user",
      email: "other@example.com",
      displayName: "Other User"
    });
    const otherSession = await loginWithOidc(app);

    const otherProjectsResponse = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: otherSession.sessionCookie
      }
    });

    expect(otherProjectsResponse.statusCode).toBe(200);
    expect(otherProjectsResponse.json()).toEqual([]);

    const otherTaskTagsResponse = await app.inject({
      method: "GET",
      url: "/api/v1/task-tags",
      cookies: {
        bbtodo_session: otherSession.sessionCookie
      }
    });

    expect(otherTaskTagsResponse.statusCode).toBe(200);
    expect(otherTaskTagsResponse.json()).toEqual([]);

    const otherDeleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${project.id}`,
      cookies: {
        bbtodo_session: otherSession.sessionCookie
      }
    });

    expect(otherDeleteResponse.statusCode).toBe(404);

    const otherLookupResponse = await app.inject({
      method: "GET",
      url: `/api/v1/tasks/by-ticket/${ownerTask.ticketId}`,
      cookies: {
        bbtodo_session: otherSession.sessionCookie
      }
    });

    expect(otherLookupResponse.statusCode).toBe(404);
    expect(otherLookupResponse.json()).toEqual({
      message: "Task not found."
    });

    const otherProjectLookupResponse = await app.inject({
      method: "GET",
      url: `/api/v1/projects/by-ticket-prefix/${project.ticketPrefix}`,
      cookies: {
        bbtodo_session: otherSession.sessionCookie
      }
    });

    expect(otherProjectLookupResponse.statusCode).toBe(404);
    expect(otherProjectLookupResponse.json()).toEqual({
      message: "Project not found."
    });

    const openApiResponse = await app.inject({
      method: "GET",
      url: "/docs/openapi.json"
    });
    const swaggerUiJsonResponse = await app.inject({
      method: "GET",
      url: "/docs/json"
    });

    expect(openApiResponse.statusCode).toBe(200);
    expect(openApiResponse.headers["cache-control"]).toBe("no-store");
    expect(swaggerUiJsonResponse.statusCode).toBe(200);
    expect(swaggerUiJsonResponse.headers["cache-control"]).toBe("no-store");
    const openApi = openApiResponse.json();
    const swaggerUiJson = swaggerUiJsonResponse.json();
    expect(openApi.openapi).toBe("3.1.0");
    expect(openApi.components?.securitySchemes).toEqual(
      expect.objectContaining({
        apiToken: expect.objectContaining({
          type: "http",
          scheme: "bearer",
          bearerFormat: "API token"
        }),
        sessionCookie: expect.objectContaining({
          type: "apiKey",
          in: "cookie",
          name: "bbtodo_session"
        })
      })
    );
    expect(openApi.components?.schemas).toEqual(
      expect.objectContaining({
        ErrorResponse: expect.any(Object),
        Task: expect.any(Object),
        TodoProjectGroup: expect.any(Object),
        TaskTagInput: expect.any(Object)
      })
    );
    expect(openApi.paths["/api/v1/task-tags"]).toBeDefined();
    expect(openApi.paths["/api/v1/todos"]).toBeDefined();
    expect(openApi.paths["/api/v1/projects"]).toBeDefined();
    expect(openApi.paths["/api/v1/projects/by-ticket-prefix/{ticketPrefix}"]).toBeDefined();
    expect(openApi.paths["/api/v1/tasks/by-ticket/{ticketId}"]).toBeDefined();
    expect(openApi.paths["/api/v1/projects/{projectId}/lanes"]).toBeDefined();
    expect(openApi.paths["/api/v1/projects/{projectId}/lanes/{laneId}"]).toBeDefined();
    expect(openApi.paths["/api/v1/projects/{projectId}/tasks"]).toBeDefined();
    expect(openApi.paths["/api/v1/projects"].get.security).toEqual([
      { apiToken: [] },
      { sessionCookie: [] }
    ]);
    expect(openApi.paths["/api/v1/api-tokens"].post.security).toEqual([
      { sessionCookie: [] }
    ]);
    expect(swaggerUiJson.components.schemas.TaskTag.$id).toBeUndefined();
    expect(swaggerUiJson.components.schemas.TaskTag.$schema).toBeUndefined();
    expect(swaggerUiJson.paths["/api/v1/task-tags"].get.responses["200"].content["application/json"].schema.items).toEqual({
      $ref: "#/components/schemas/TaskTag"
    });
    expect(swaggerUiJson.paths["/api/v1/todos"].get.responses["200"].content["application/json"].schema.items).toEqual({
      $ref: "#/components/schemas/TodoProjectGroup"
    });
    expect(
      openApi.paths["/api/v1/projects/{projectId}/tasks"].post.requestBody.content["application/json"].schema.properties
        .tags.items.anyOf[1]
    ).toEqual({
      $ref: "#/components/schemas/TaskTagInput"
    });
    expect(
      openApi.paths["/api/v1/projects/{projectId}/tasks/{taskId}"].patch.requestBody.content["application/json"]
        .schema.properties.destinationProjectId
    ).toMatchObject({
      format: "uuid",
      type: "string"
    });
    expect(openApi.components.schemas.Project.properties.ticketPrefix).toEqual({
      pattern: "^[A-Z]{2,4}$",
      type: "string"
    });
    expect(openApi.components.schemas.Task.properties.ticketId).toEqual({
      type: "string"
    });
    expect(openApi.paths["/api/v1/projects/{projectId}/tasks"].post.responses["201"]).toEqual({
      content: {
        "application/json": {
          schema: {
            $ref: "#/components/schemas/Task"
          }
        }
      },
      description: "Default Response"
    });
    expect(openApi.paths["/api/v1/tasks/by-ticket/{ticketId}"].get.responses["200"]).toEqual({
      content: {
        "application/json": {
          schema: {
            $ref: "#/components/schemas/Task"
          }
        }
      },
      description: "Default Response"
    });
    expect(openApi.paths["/api/v1/todos"].get.responses["200"]).toEqual({
      content: {
        "application/json": {
          schema: {
            items: {
              $ref: "#/components/schemas/TodoProjectGroup"
            },
            type: "array"
          }
        }
      },
      description: "Default Response"
    });
    expect(openApi.paths["/api/v1/projects/by-ticket-prefix/{ticketPrefix}"].get.responses["200"]).toEqual({
      content: {
        "application/json": {
          schema: {
            $ref: "#/components/schemas/Project"
          }
        }
      },
      description: "Default Response"
    });
  });

  it("supports custom lanes plus task body and ordering updates", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "user-1",
      email: "one@example.com",
      displayName: "User One"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);

    const createProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Editorial board"
      }
    });
    const project = createProjectResponse.json();

    const createLaneResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/lanes`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Ready for QA"
      }
    });

    expect(createLaneResponse.statusCode).toBe(201);
    expect(createLaneResponse.json()).toMatchObject({
      name: "Ready for QA",
      position: 4,
      taskCount: 0
    });
    const qaLane = createLaneResponse.json();

    const createTaskOneResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Draft release note",
        body: "## Summary\n\n- ship docs",
        laneId: qaLane.id,
        tags: [tag("docs", "sky"), tag("qa", "orchid")]
      }
    });
    const createTaskTwoResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Polish QA copy",
        laneId: qaLane.id
      }
    });

    expect(createTaskOneResponse.statusCode).toBe(201);
    expect(createTaskTwoResponse.statusCode).toBe(201);
    expect(createTaskOneResponse.json()).toMatchObject({
      body: "## Summary\n\n- ship docs",
      laneId: qaLane.id,
      tags: [tag("docs", "sky"), tag("qa", "orchid")],
      position: 0
    });
    expect(createTaskTwoResponse.json()).toMatchObject({
      laneId: qaLane.id,
      position: 1
    });

    const firstTask = createTaskOneResponse.json();
    const secondTask = createTaskTwoResponse.json();

    const reorderTaskResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/tasks/${secondTask.id}`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        body: "Updated body",
        tags: [tag("copy", "amber"), tag("qa", "orchid")],
        position: 0
      }
    });

    expect(reorderTaskResponse.statusCode).toBe(200);
    expect(reorderTaskResponse.json()).toMatchObject({
      body: "Updated body",
      id: secondTask.id,
      laneId: qaLane.id,
      position: 0,
      tags: [tag("copy", "amber"), tag("qa", "orchid")]
    });

    const reorderLaneResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/lanes/${qaLane.id}`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        position: 1
      }
    });

    expect(reorderLaneResponse.statusCode).toBe(200);
    expect(reorderLaneResponse.json()).toMatchObject({
      id: qaLane.id,
      position: 1
    });

    const lanesResponse = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/lanes`,
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(lanesResponse.statusCode).toBe(200);
    expect(lanesResponse.json()).toHaveLength(5);
    expect(lanesResponse.json().map((lane: { name: string }) => lane.name)).toEqual([
      "Todo",
      "Ready for QA",
      "In Progress",
      "In review",
      "Done"
    ]);
    expect(lanesResponse.json()[1]).toMatchObject({
      id: qaLane.id,
      name: "Ready for QA",
      taskCount: 2
    });

    const qaTasksResponse = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(qaTasksResponse.statusCode).toBe(200);
    expect(qaTasksResponse.json().filter((task: { laneId: string }) => task.laneId === qaLane.id)).toEqual([
      expect.objectContaining({
        id: secondTask.id,
        position: 0,
        tags: [tag("copy", "amber"), tag("qa", "orchid")]
      }),
      expect.objectContaining({
        id: firstTask.id,
        position: 1,
        tags: [tag("docs", "sky"), tag("qa", "orchid")]
      })
    ]);
  });

  it("deletes custom lanes and moves tasks into another lane", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "user-1",
      email: "one@example.com",
      displayName: "User One"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);

    const createProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "QA board"
      }
    });
    const project = createProjectResponse.json();
    const doneLane = project.laneSummaries[3];

    const createLaneResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/lanes`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Ready for QA"
      }
    });
    const qaLane = createLaneResponse.json();

    const doneTaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Already shipped",
        laneId: doneLane.id
      }
    });
    const firstQaTaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Draft changelog",
        laneId: qaLane.id,
        tags: [tag("qa", "orchid")]
      }
    });
    const secondQaTaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Verify release note",
        laneId: qaLane.id
      }
    });

    const deleteWithoutDestinationResponse = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${project.id}/lanes/${qaLane.id}`,
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(deleteWithoutDestinationResponse.statusCode).toBe(400);
    expect(deleteWithoutDestinationResponse.json()).toEqual({
      message: "Select a destination lane before deleting this lane."
    });

    const deleteLaneResponse = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${project.id}/lanes/${qaLane.id}`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        destinationLaneId: doneLane.id
      }
    });

    expect(deleteLaneResponse.statusCode).toBe(204);

    const lanesResponse = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/lanes`,
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(lanesResponse.statusCode).toBe(200);
    expect(lanesResponse.json().map((lane: { name: string }) => lane.name)).toEqual([
      "Todo",
      "In Progress",
      "In review",
      "Done"
    ]);
    expect(
      lanesResponse.json().find((lane: { id: string }) => lane.id === doneLane.id)
    ).toMatchObject({
      id: doneLane.id,
      taskCount: 3
    });

    const tasksResponse = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(tasksResponse.statusCode).toBe(200);
    expect(
      tasksResponse.json().filter((task: { laneId: string }) => task.laneId === doneLane.id)
    ).toEqual([
      expect.objectContaining({
        id: firstQaTaskResponse.json().id,
        laneId: doneLane.id,
        position: 1,
        tags: [tag("qa", "orchid")]
      }),
      expect.objectContaining({
        id: secondQaTaskResponse.json().id,
        laneId: doneLane.id,
        position: 2
      }),
      expect.objectContaining({
        id: doneTaskResponse.json().id,
        laneId: doneLane.id,
        position: 0
      })
    ]);
  });

  it("rejects deleting protected Todo and Done lanes", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "user-1",
      email: "one@example.com",
      displayName: "User One"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);

    const createProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Protected lanes"
      }
    });
    const project = createProjectResponse.json();
    const todoLane = project.laneSummaries[0];
    const doneLane = project.laneSummaries[3];

    for (const lane of [todoLane, doneLane]) {
      const deleteLaneResponse = await app.inject({
        method: "DELETE",
        url: `/api/v1/projects/${project.id}/lanes/${lane.id}`,
        cookies: {
          bbtodo_session: session.sessionCookie
        }
      });

      expect(deleteLaneResponse.statusCode).toBe(400);
      expect(deleteLaneResponse.json()).toEqual({
        message: "Todo and Done lanes cannot be deleted."
      });
    }
  });

  it("lists Done tasks in updated-at descending order after moves and updates", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "user-1",
      email: "one@example.com",
      displayName: "User One"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);

    const createProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Done ordering"
      }
    });
    const project = createProjectResponse.json();
    const inProgressLane = project.laneSummaries[1];
    const doneLane = project.laneSummaries[3];

    const firstDoneTaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Already done",
        laneId: doneLane.id
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const movedTaskResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Move me later",
        laneId: inProgressLane.id
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/tasks/${movedTaskResponse.json().id}`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        laneId: doneLane.id
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/tasks/${firstDoneTaskResponse.json().id}`,
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        title: "Already done, updated"
      }
    });

    const tasksResponse = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/tasks`,
      cookies: {
        bbtodo_session: session.sessionCookie
      }
    });

    expect(tasksResponse.statusCode).toBe(200);
    expect(
      tasksResponse
        .json()
        .filter((task: { laneId: string }) => task.laneId === doneLane.id)
        .map((task: { id: string }) => task.id)
    ).toEqual([firstDoneTaskResponse.json().id, movedTaskResponse.json().id]);
  });

  it("keeps the remaining protected lanes undeletable", async () => {
    const oidc = createMutableMockOidcProvider({
      subject: "user-1",
      email: "one@example.com",
      displayName: "User One"
    });
    const app = buildApp({
      config: testConfig,
      oidcProvider: oidc.provider,
      sqlitePath: ":memory:"
    });
    createdApps.push(app);

    const session = await loginWithOidc(app);

    const createProjectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      cookies: {
        bbtodo_session: session.sessionCookie
      },
      payload: {
        name: "Minimal board"
      }
    });
    const project = createProjectResponse.json();

    for (const lane of project.laneSummaries.slice(1, -1)) {
      const deleteLaneResponse = await app.inject({
        method: "DELETE",
        url: `/api/v1/projects/${project.id}/lanes/${lane.id}`,
        cookies: {
          bbtodo_session: session.sessionCookie
        }
      });

      expect(deleteLaneResponse.statusCode).toBe(204);
    }

    for (const lane of [project.laneSummaries[0], project.laneSummaries[3]]) {
      const deleteProtectedLaneResponse = await app.inject({
        method: "DELETE",
        url: `/api/v1/projects/${project.id}/lanes/${lane.id}`,
        cookies: {
          bbtodo_session: session.sessionCookie
        }
      });

      expect(deleteProtectedLaneResponse.statusCode).toBe(400);
      expect(deleteProtectedLaneResponse.json()).toEqual({
        message: "Todo and Done lanes cannot be deleted."
      });
    }
  });
});
