import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createDatabase,
  createLane,
  createProject,
  createTask,
  listLanesForProject,
  updateOwnedLane,
  updateOwnedTask,
  upsertUser
} from "../db.js";

describe("board writes", () => {
  let services: ReturnType<typeof createDatabase>;
  let projectId: string;
  let userId: string;

  beforeEach(async () => {
    services = createDatabase(":memory:");
    const user = await upsertUser(services.db, {
      displayName: null,
      email: null,
      issuer: "https://issuer.example.com/",
      subject: "board-writes"
    });
    userId = user.id;
    projectId = createProject(services.db, userId, "Atomic writes").id;
  });

  afterEach(() => {
    services.database.close();
  });

  // Touching the project is the last write in each of these operations, so failing it
  // leaves every earlier write committed unless the operation runs in one transaction.
  function failNextProjectTouch() {
    services.database.exec(`
      CREATE TRIGGER fail_project_touch BEFORE UPDATE ON projects
      BEGIN
        SELECT RAISE(ABORT, 'forced failure');
      END;
    `);
  }

  function readTaskPositions() {
    return services.database.prepare("SELECT id, position FROM tasks ORDER BY id").all();
  }

  function readLanePositions() {
    return services.database.prepare("SELECT id, position FROM lanes ORDER BY id").all();
  }

  function createTasks(titles: string[]) {
    return titles.map((title) => {
      const created = createTask(services.db, { projectId, title, userId });
      if (created.status !== "created") {
        throw new Error(`Could not create task ${title}: ${created.status}`);
      }

      return created.task;
    });
  }

  it("rolls back a card reorder when a later write fails", () => {
    const [, , lastTask] = createTasks(["first", "second", "third"]);
    const before = readTaskPositions();

    failNextProjectTouch();

    expect(() =>
      updateOwnedTask(services.db, {
        position: 0,
        projectId,
        taskId: lastTask!.id,
        title: "Renamed",
        userId
      })
    ).toThrow("forced failure");
    expect(readTaskPositions()).toEqual(before);
  });

  it("rolls back a lane reorder when a later write fails", () => {
    const [firstLane] = listLanesForProject(services.db, { projectId, userId }) ?? [];
    const before = readLanePositions();

    failNextProjectTouch();

    expect(() =>
      updateOwnedLane(services.db, {
        laneId: firstLane!.id,
        position: 2,
        projectId,
        userId
      })
    ).toThrow("forced failure");
    expect(readLanePositions()).toEqual(before);
  });

  it("does not keep a new lane when a later write fails", () => {
    const before = readLanePositions();

    failNextProjectTouch();

    expect(() => createLane(services.db, { name: "Blocked", projectId, userId })).toThrow("forced failure");
    expect(readLanePositions()).toEqual(before);
  });
});
