import { and, asc, desc, eq, inArray, isNull, max, ne, or } from "drizzle-orm";

import {
  type DatabaseClient,
  defaultLaneTemplates,
  defaultTaskTagColor,
  type LaneRecord,
  lanes,
  type ProjectRecord,
  projects,
  type TaskRecord,
  type TaskRecordWithTags,
  tasks,
  taskTagColorValues,
  type TaskTagColor,
  type TaskTagData,
  type TaskTagInput,
  taskTags
} from "./schema.js";
import { resolveProjectTicketPrefix } from "../services/ticket-prefix.js";

function normalizeTaskTagLabel(tag: string) {
  const normalized = tag.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

function normalizeLaneName(name: string) {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function isDoneLaneName(name: string) {
  return normalizeLaneName(name) === "done";
}

function isProtectedLaneName(name: string) {
  const normalizedLaneName = normalizeLaneName(name);
  return normalizedLaneName === "todo" || normalizedLaneName === "done";
}

function normalizeTaskTagColor(color: string | undefined): TaskTagColor {
  return taskTagColorValues.includes(color as TaskTagColor)
    ? (color as TaskTagColor)
    : defaultTaskTagColor;
}

function normalizeTaskTags(tags: TaskTagInput[] | undefined) {
  if (!tags) {
    return [];
  }

  const seen = new Set<string>();
  const normalizedTags: TaskTagData[] = [];

  tags.forEach((tag) => {
    const normalizedLabel = normalizeTaskTagLabel(typeof tag === "string" ? tag : tag.label);
    if (!normalizedLabel) {
      return;
    }

    const key = normalizedLabel.toLowerCase();
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    normalizedTags.push({
      color: typeof tag === "string" ? defaultTaskTagColor : normalizeTaskTagColor(tag.color),
      label: normalizedLabel
    });
  });

  return normalizedTags;
}

function requireProjectTicketPrefix(project: Pick<ProjectRecord, "id" | "ticketPrefix">) {
  if (!project.ticketPrefix) {
    throw new Error(`Project ${project.id} is missing a ticket prefix.`);
  }

  return project.ticketPrefix;
}

function requireTaskTicketNumber(task: Pick<TaskRecord, "id" | "ticketNumber">) {
  if (task.ticketNumber === null) {
    throw new Error(`Task ${task.id} is missing a ticket number.`);
  }

  return task.ticketNumber;
}

function listTaskTagMap(db: DatabaseClient, taskIds: string[]) {
  if (taskIds.length === 0) {
    return new Map<string, TaskTagData[]>();
  }

  const rows = db
    .select({
      color: taskTags.color,
      tag: taskTags.tag,
      taskId: taskTags.taskId
    })
    .from(taskTags)
    .where(inArray(taskTags.taskId, taskIds))
    .orderBy(asc(taskTags.taskId), asc(taskTags.position))
    .all();

  const tagMap = new Map<string, TaskTagData[]>(taskIds.map((taskId) => [taskId, []]));

  rows.forEach((row) => {
    tagMap.get(row.taskId)?.push({
      color: normalizeTaskTagColor(row.color),
      label: row.tag
    });
  });

  return tagMap;
}

function attachTagsToTasks(db: DatabaseClient, taskRows: TaskRecord[]) {
  const tagMap = listTaskTagMap(
    db,
    taskRows.map((task) => task.id)
  );

  return taskRows.map((task) => ({
    ...task,
    tags: tagMap.get(task.id) ?? []
  })) satisfies TaskRecordWithTags[];
}

function getTaskWithTags(db: DatabaseClient, taskId: string) {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) {
    return null;
  }

  return attachTagsToTasks(db, [task])[0] ?? null;
}

function replaceTaskTags(db: DatabaseClient, taskId: string, tags: TaskTagInput[]) {
  db.delete(taskTags).where(eq(taskTags.taskId, taskId)).run();

  normalizeTaskTags(tags).forEach((tag, index) => {
    db
      .insert(taskTags)
      .values({
        color: tag.color,
        id: crypto.randomUUID(),
        taskId,
        tag: tag.label,
        position: index
      })
      .run();
  });
}

function syncTaskTagColorsForUser(db: DatabaseClient, userId: string, tags: TaskTagInput[] | undefined) {
  const desiredColorsByKey = new Map(
    normalizeTaskTags(tags).map((tag) => [tag.label.toLowerCase(), tag.color] as const)
  );
  if (desiredColorsByKey.size === 0) {
    return;
  }

  const rows = db
    .select({
      color: taskTags.color,
      id: taskTags.id,
      label: taskTags.tag
    })
    .from(taskTags)
    .innerJoin(tasks, eq(taskTags.taskId, tasks.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(eq(projects.userId, userId))
    .all();

  rows.forEach((row) => {
    const normalizedLabel = normalizeTaskTagLabel(row.label);
    if (!normalizedLabel) {
      return;
    }

    const desiredColor = desiredColorsByKey.get(normalizedLabel.toLowerCase());
    if (!desiredColor || normalizeTaskTagColor(row.color) === desiredColor) {
      return;
    }

    db
      .update(taskTags)
      .set({ color: desiredColor })
      .where(eq(taskTags.id, row.id))
      .run();
  });
}

function touchProject(db: DatabaseClient, projectId: string, updatedAt: string) {
  db.update(projects).set({ updatedAt }).where(eq(projects.id, projectId)).run();
}

function getProjectLaneById(db: DatabaseClient, projectId: string, laneId: string) {
  return db
    .select()
    .from(lanes)
    .where(and(eq(lanes.id, laneId), eq(lanes.projectId, projectId)))
    .get();
}

function getProjectTaskById(db: DatabaseClient, projectId: string, taskId: string) {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)))
    .get();
}

function parseTicketId(ticketId: string) {
  const match = ticketId.trim().match(/^([A-Z]{2,4})-([1-9]\d*)$/);
  if (!match) {
    return null;
  }

  return {
    ticketNumber: Number.parseInt(match[2], 10),
    ticketPrefix: match[1]
  };
}

function resolveTaskLane(
  db: DatabaseClient,
  input: {
    laneId?: string;
    projectId: string;
  },
  currentTask?: TaskRecord
) {
  if (input.laneId) {
    return getProjectLaneById(db, input.projectId, input.laneId);
  }

  if (currentTask?.laneId) {
    return getProjectLaneById(db, input.projectId, currentTask.laneId);
  }

  return listProjectLanesByProjectId(db, input.projectId)[0] ?? null;
}

function compareTaskRecordsInLane(left: TaskRecord, right: TaskRecord, isDoneLane: boolean) {
  if (isDoneLane) {
    if (left.updatedAt !== right.updatedAt) {
      return left.updatedAt < right.updatedAt ? 1 : -1;
    }

    if (left.position !== right.position) {
      return left.position - right.position;
    }

    return left.id.localeCompare(right.id);
  }

  if (left.position !== right.position) {
    return left.position - right.position;
  }

  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt < right.updatedAt ? 1 : -1;
  }

  return left.id.localeCompare(right.id);
}

function listSiblingTaskIds(
  db: DatabaseClient,
  input: {
    excludedTaskId?: string;
    laneId: string;
    parentTaskId: string | null;
    projectId: string;
  }
) {
  const filters = [eq(tasks.projectId, input.projectId), eq(tasks.laneId, input.laneId)];

  if (input.parentTaskId === null) {
    filters.push(isNull(tasks.parentTaskId));
  } else {
    filters.push(eq(tasks.parentTaskId, input.parentTaskId));
  }

  if (input.excludedTaskId) {
    filters.push(ne(tasks.id, input.excludedTaskId));
  }

  return db
    .select({
      id: tasks.id
    })
    .from(tasks)
    .where(and(...filters))
    .orderBy(asc(tasks.position), desc(tasks.updatedAt))
    .all()
    .map((task) => task.id);
}

function listChildTaskIds(db: DatabaseClient, parentTaskId: string) {
  return db
    .select({
      id: tasks.id
    })
    .from(tasks)
    .where(eq(tasks.parentTaskId, parentTaskId))
    .orderBy(asc(tasks.position), desc(tasks.updatedAt))
    .all()
    .map((task) => task.id);
}

function taskHasChildren(db: DatabaseClient, taskId: string) {
  return listChildTaskIds(db, taskId).length > 0;
}

function resolveTaskPlacement(
  db: DatabaseClient,
  input: {
    laneId?: string;
    parentTaskId?: string | null;
    projectId: string;
  },
  currentTask?: TaskRecord
):
  | {
      lane: LaneRecord;
      parentTask: TaskRecord | null;
      status: "ok";
    }
  | {
      status: "invalid_parent" | "lane_not_found" | "parent_not_found";
    } {
  const nextParentTaskId =
    input.parentTaskId === undefined ? currentTask?.parentTaskId ?? null : input.parentTaskId;

  if (nextParentTaskId !== null) {
    const parentTask = getProjectTaskById(db, input.projectId, nextParentTaskId);
    if (!parentTask) {
      return {
        status: "parent_not_found"
      };
    }

    if (currentTask && parentTask.id === currentTask.id) {
      return {
        status: "invalid_parent"
      };
    }

    if (parentTask.parentTaskId !== null) {
      return {
        status: "invalid_parent"
      };
    }

    if (currentTask && taskHasChildren(db, currentTask.id)) {
      return {
        status: "invalid_parent"
      };
    }

    if (!parentTask.laneId) {
      return {
        status: "invalid_parent"
      };
    }

    const lane = getProjectLaneById(db, input.projectId, parentTask.laneId);
    if (!lane) {
      return {
        status: "lane_not_found"
      };
    }

    return {
      lane,
      parentTask,
      status: "ok"
    };
  }

  const lane = resolveTaskLane(
    db,
    {
      laneId: input.laneId,
      projectId: input.projectId
    },
    currentTask
  );
  if (!lane) {
    return {
      status: "lane_not_found"
    };
  }

  return {
    lane,
    parentTask: null,
    status: "ok"
  };
}

function reorderTaskSiblings(
  db: DatabaseClient,
  input: {
    projectId: string;
    taskId: string;
    targetParentTaskId: string | null;
    targetLaneId: string;
    targetPosition: number;
  }
) {
  const task = db.select().from(tasks).where(eq(tasks.id, input.taskId)).get();
  if (!task || !task.laneId) {
    return;
  }

  const sourceLaneId = task.laneId;
  const sourceParentTaskId = task.parentTaskId;
  const sourceTaskIds = listSiblingTaskIds(db, {
    excludedTaskId: task.id,
    laneId: sourceLaneId,
    parentTaskId: sourceParentTaskId,
    projectId: input.projectId
  });
  const targetTaskIds = listSiblingTaskIds(db, {
    excludedTaskId: task.id,
    laneId: input.targetLaneId,
    parentTaskId: input.targetParentTaskId,
    projectId: input.projectId
  });
  const clampedPosition = Math.max(0, Math.min(input.targetPosition, targetTaskIds.length));
  targetTaskIds.splice(clampedPosition, 0, task.id);

  sourceTaskIds.forEach((taskId, index) => {
    db
      .update(tasks)
      .set({ position: index })
      .where(eq(tasks.id, taskId))
      .run();
  });

  targetTaskIds.forEach((taskId, index) => {
    db
      .update(tasks)
      .set({ position: index })
      .where(eq(tasks.id, taskId))
      .run();
  });
}

function moveSubtasksToLane(db: DatabaseClient, parentTaskId: string, laneId: string, updatedAt: string) {
  db
    .update(tasks)
    .set({
      laneId,
      updatedAt
    })
    .where(eq(tasks.parentTaskId, parentTaskId))
    .run();
}

function orderTasksForProject<T extends TaskRecord>(taskRows: T[], projectLanes: LaneRecord[]) {
  const tasksById = new Map(taskRows.map((task) => [task.id, task]));
  const topLevelByLane = new Map<string, T[]>();
  const subtasksByParent = new Map<string, T[]>();
  const orderedTasks: T[] = [];
  const includedTaskIds = new Set<string>();

  taskRows.forEach((task) => {
    if (task.parentTaskId === null) {
      if (!task.laneId) {
        return;
      }

      const laneTasks = topLevelByLane.get(task.laneId) ?? [];
      laneTasks.push(task);
      topLevelByLane.set(task.laneId, laneTasks);
      return;
    }

    const childTasks = subtasksByParent.get(task.parentTaskId) ?? [];
    childTasks.push(task);
    subtasksByParent.set(task.parentTaskId, childTasks);
  });

  projectLanes.forEach((lane) => {
    const laneTasks = (topLevelByLane.get(lane.id) ?? []).sort((left, right) =>
      compareTaskRecordsInLane(left, right, isDoneLaneName(lane.name))
    );
    laneTasks.forEach((task) => {
      orderedTasks.push(task);
      includedTaskIds.add(task.id);

      const childTasks = (subtasksByParent.get(task.id) ?? []).sort((left, right) =>
        compareTaskRecordsInLane(left, right, isDoneLaneName(lane.name))
      );
      childTasks.forEach((childTask) => {
        orderedTasks.push(childTask);
        includedTaskIds.add(childTask.id);
      });
    });
  });

  taskRows
    .filter((task) => !includedTaskIds.has(task.id))
    .sort((left, right) => compareTaskRecordsInLane(left, right, false))
    .forEach((task) => {
      if (task.parentTaskId !== null && !tasksById.has(task.parentTaskId)) {
        orderedTasks.push({
          ...task,
          parentTaskId: null
        } as T);
        return;
      }

      orderedTasks.push(task);
    });

  return orderedTasks;
}

function createProjectLanesFromTemplates(
  db: DatabaseClient,
  projectId: string,
  now: string,
  laneTemplates: readonly string[]
) {
  const createdLanes: LaneRecord[] = [];

  laneTemplates.forEach((name, index) => {
    const lane = {
      id: crypto.randomUUID(),
      projectId,
      name,
      position: index,
      createdAt: now,
      updatedAt: now
    };

    db.insert(lanes).values(lane).run();
    createdLanes.push(lane);
  });

  return createdLanes;
}

function listProjectLanesByProjectId(db: DatabaseClient, projectId: string) {
  return db
    .select()
    .from(lanes)
    .where(eq(lanes.projectId, projectId))
    .orderBy(asc(lanes.position), asc(lanes.createdAt))
    .all();
}

export function listTaskTagsForUser(db: DatabaseClient, userId: string) {
  const rows = db
    .select({
      color: taskTags.color,
      label: taskTags.tag
    })
    .from(taskTags)
    .innerJoin(tasks, eq(taskTags.taskId, tasks.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(eq(projects.userId, userId))
    .orderBy(desc(tasks.updatedAt), asc(taskTags.position), asc(taskTags.tag))
    .all();

  const tagsByKey = new Map<string, TaskTagData>();

  rows.forEach((row) => {
    const normalizedLabel = normalizeTaskTagLabel(row.label);
    if (!normalizedLabel) {
      return;
    }

    const key = normalizedLabel.toLowerCase();
    if (tagsByKey.has(key)) {
      return;
    }

    tagsByKey.set(key, {
      color: normalizeTaskTagColor(row.color),
      label: normalizedLabel
    });
  });

  return Array.from(tagsByKey.values()).sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { sensitivity: "base" })
  );
}

export function listProjectsForUser(db: DatabaseClient, userId: string) {
  const projectRows = db
    .select()
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.updatedAt))
    .all();

  if (projectRows.length === 0) {
    return [];
  }

  const projectIds = projectRows.map((project) => project.id);
  const laneRows = db
    .select()
    .from(lanes)
    .where(inArray(lanes.projectId, projectIds))
    .orderBy(asc(lanes.position), asc(lanes.createdAt))
    .all();
  const laneCounts = new Map<string, number>(laneRows.map((lane) => [lane.id, 0]));

  const taskRows = db
    .select({
      laneId: tasks.laneId,
      projectId: tasks.projectId
    })
    .from(tasks)
    .where(inArray(tasks.projectId, projectIds))
    .all();

  taskRows.forEach((task) => {
    if (task.laneId) {
      laneCounts.set(task.laneId, (laneCounts.get(task.laneId) ?? 0) + 1);
    }
  });

  return projectRows.map((project) => ({
    ...project,
    laneSummaries: laneRows
      .filter((lane) => lane.projectId === project.id)
      .map((lane) => ({
        ...lane,
        taskCount: laneCounts.get(lane.id) ?? 0
      }))
  }));
}

export function listTodoProjectGroupsForUser(db: DatabaseClient, userId: string) {
  const projectRows = db
    .select()
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.updatedAt))
    .all();

  if (projectRows.length === 0) {
    return [];
  }

  const projectIds = projectRows.map((project) => project.id);
  const laneRows = db
    .select()
    .from(lanes)
    .where(inArray(lanes.projectId, projectIds))
    .orderBy(asc(lanes.position), asc(lanes.createdAt))
    .all();
  const todoLanesByProjectId = new Map<string, LaneRecord>();

  for (const lane of laneRows) {
    if (!todoLanesByProjectId.has(lane.projectId) && normalizeLaneName(lane.name) === "todo") {
      todoLanesByProjectId.set(lane.projectId, lane);
    }
  }

  const todoLaneIds = Array.from(todoLanesByProjectId.values(), (lane) => lane.id);
  if (todoLaneIds.length === 0) {
    return [];
  }

  const tasksWithTags = attachTagsToTasks(
    db,
    db
      .select()
      .from(tasks)
      .where(inArray(tasks.laneId, todoLaneIds))
      .all()
  );

  if (tasksWithTags.length === 0) {
    return [];
  }

  const tasksByProjectId = new Map<string, TaskRecordWithTags[]>();

  tasksWithTags.forEach((task) => {
    const projectTasks = tasksByProjectId.get(task.projectId) ?? [];
    projectTasks.push(task);
    tasksByProjectId.set(task.projectId, projectTasks);
  });

  return projectRows.flatMap((project) => {
    const todoLane = todoLanesByProjectId.get(project.id);
    const projectTasks = tasksByProjectId.get(project.id) ?? [];

    if (!todoLane || projectTasks.length === 0) {
      return [];
    }

    return [
      {
        projectId: project.id,
        projectName: project.name,
        projectTicketPrefix: requireProjectTicketPrefix(project),
        tasks: orderTasksForProject(projectTasks, [todoLane])
      }
    ];
  });
}

export function backfillTicketIds(db: DatabaseClient) {
  db.transaction((tx) => {
    const allProjects = tx
      .select()
      .from(projects)
      .orderBy(asc(projects.userId), asc(projects.createdAt), asc(projects.id))
      .all();
    const projectsByUser = new Map<string, ProjectRecord[]>();

    allProjects.forEach((project) => {
      const userProjects = projectsByUser.get(project.userId) ?? [];
      userProjects.push(project);
      projectsByUser.set(project.userId, userProjects);
    });

    projectsByUser.forEach((userProjects, userId) => {
      const usedPrefixes = new Set<string>();

      userProjects.forEach((project) => {
        if (!project.ticketPrefix) {
          return;
        }

        if (usedPrefixes.has(project.ticketPrefix)) {
          throw new Error(
            `User ${userId} has duplicate ticket prefix ${project.ticketPrefix} on project ${project.id}.`
          );
        }

        usedPrefixes.add(project.ticketPrefix);
      });

      userProjects.forEach((project) => {
        if (project.ticketPrefix) {
          return;
        }

        const prefix = resolveProjectTicketPrefix(project.name, usedPrefixes);

        tx
          .update(projects)
          .set({
            ticketPrefix: prefix
          })
          .where(eq(projects.id, project.id))
          .run();

        project.ticketPrefix = prefix;
        usedPrefixes.add(prefix);
      });
    });

    allProjects.forEach((project) => {
      const projectTicketPrefix = requireProjectTicketPrefix(project);
      const projectTasks = tx
        .select()
        .from(tasks)
        .where(eq(tasks.projectId, project.id))
        .orderBy(asc(tasks.createdAt), asc(tasks.id))
        .all();
      const usedTicketNumbers = new Set<number>();
      let highestTicketNumber = 0;
      let nextAvailableTicketNumber = 1;

      projectTasks.forEach((task) => {
        if (task.ticketNumber === null) {
          return;
        }

        if (usedTicketNumbers.has(task.ticketNumber)) {
          throw new Error(
            `Project ${project.id} (${projectTicketPrefix}) has duplicate ticket number ${task.ticketNumber}.`
          );
        }

        usedTicketNumbers.add(task.ticketNumber);
        highestTicketNumber = Math.max(highestTicketNumber, task.ticketNumber);
      });

      projectTasks.forEach((task) => {
        if (task.ticketNumber !== null) {
          return;
        }

        while (usedTicketNumbers.has(nextAvailableTicketNumber)) {
          nextAvailableTicketNumber += 1;
        }

        tx
          .update(tasks)
          .set({
            ticketNumber: nextAvailableTicketNumber
          })
          .where(eq(tasks.id, task.id))
          .run();

        task.ticketNumber = nextAvailableTicketNumber;
        usedTicketNumbers.add(nextAvailableTicketNumber);
        highestTicketNumber = Math.max(highestTicketNumber, nextAvailableTicketNumber);
        nextAvailableTicketNumber += 1;
      });

      const resolvedNextTicketNumber = Math.max(project.nextTicketNumber ?? 1, highestTicketNumber + 1, 1);
      if (project.nextTicketNumber !== resolvedNextTicketNumber) {
        tx
          .update(projects)
          .set({
            nextTicketNumber: resolvedNextTicketNumber
          })
          .where(eq(projects.id, project.id))
          .run();
      }
    });

    const projectWithMissingTicketData = tx
      .select({
        id: projects.id
      })
      .from(projects)
      .where(or(isNull(projects.ticketPrefix), isNull(projects.nextTicketNumber)))
      .get();
    if (projectWithMissingTicketData) {
      throw new Error(`Project ${projectWithMissingTicketData.id} is missing ticket metadata after backfill.`);
    }

    const taskWithMissingTicketData = tx
      .select({
        id: tasks.id
      })
      .from(tasks)
      .where(isNull(tasks.ticketNumber))
      .get();
    if (taskWithMissingTicketData) {
      throw new Error(`Task ${taskWithMissingTicketData.id} is missing ticket metadata after backfill.`);
    }
  });
}

export function createProject(db: DatabaseClient, userId: string, name: string) {
  const usedPrefixes = new Set(
    db
      .select({
        ticketPrefix: projects.ticketPrefix
      })
      .from(projects)
      .where(eq(projects.userId, userId))
      .all()
      .flatMap((project) => (project.ticketPrefix ? [project.ticketPrefix] : []))
  );
  const now = new Date().toISOString();
  const project = {
    id: crypto.randomUUID(),
    userId,
    name,
    ticketPrefix: resolveProjectTicketPrefix(name, usedPrefixes),
    nextTicketNumber: 1,
    createdAt: now,
    updatedAt: now
  };

  db.transaction((tx) => {
    tx.insert(projects).values(project).run();
    createProjectLanesFromTemplates(tx, project.id, now, defaultLaneTemplates);
  });

  return project;
}

export function updateOwnedProjectName(
  db: DatabaseClient,
  input: {
    name: string;
    projectId: string;
    userId: string;
  }
) {
  const project = getOwnedProject(db, input.userId, input.projectId);
  if (!project) {
    return null;
  }

  const updatedAt = new Date().toISOString();

  db
    .update(projects)
    .set({
      name: input.name,
      updatedAt
    })
    .where(eq(projects.id, input.projectId))
    .run();

  return db.select().from(projects).where(eq(projects.id, input.projectId)).get() ?? null;
}

export function getOwnedProject(db: DatabaseClient, userId: string, projectId: string) {
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .get();
}

export function getOwnedProjectByTicketPrefix(
  db: DatabaseClient,
  input: {
    ticketPrefix: string;
    userId: string;
  }
) {
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.ticketPrefix, input.ticketPrefix), eq(projects.userId, input.userId)))
    .get();
}

export function deleteOwnedProject(db: DatabaseClient, userId: string, projectId: string) {
  const project = getOwnedProject(db, userId, projectId);
  if (!project) {
    return false;
  }

  db.delete(projects).where(eq(projects.id, projectId)).run();
  return true;
}

export function listLanesForProject(
  db: DatabaseClient,
  input: {
    userId: string;
    projectId: string;
  }
) {
  const project = getOwnedProject(db, input.userId, input.projectId);
  if (!project) {
    return null;
  }

  const projectLanes = listProjectLanesByProjectId(db, input.projectId);
  const laneCounts = new Map<string, number>(projectLanes.map((lane) => [lane.id, 0]));
  const taskRows = db
    .select({
      laneId: tasks.laneId
    })
    .from(tasks)
    .where(eq(tasks.projectId, input.projectId))
    .all();

  taskRows.forEach((task) => {
    if (task.laneId) {
      laneCounts.set(task.laneId, (laneCounts.get(task.laneId) ?? 0) + 1);
    }
  });

  return projectLanes.map((lane) => ({
    ...lane,
    taskCount: laneCounts.get(lane.id) ?? 0
  }));
}

export function createLane(
  db: DatabaseClient,
  input: {
    userId: string;
    projectId: string;
    name: string;
  }
) {
  const project = getOwnedProject(db, input.userId, input.projectId);
  if (!project) {
    return null;
  }

  const now = new Date().toISOString();
  const lastPosition = db
    .select({
      value: max(lanes.position)
    })
    .from(lanes)
    .where(eq(lanes.projectId, input.projectId))
    .get();

  const lane = {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    name: input.name,
    position: (lastPosition?.value ?? -1) + 1,
    createdAt: now,
    updatedAt: now
  };

  db.insert(lanes).values(lane).run();
  touchProject(db, input.projectId, now);

  return {
    ...lane,
    taskCount: 0
  };
}

export function updateOwnedLane(
  db: DatabaseClient,
  input: {
    laneId: string;
    position: number;
    projectId: string;
    userId: string;
  }
) {
  const project = getOwnedProject(db, input.userId, input.projectId);
  if (!project) {
    return null;
  }

  const lane = getProjectLaneById(db, input.projectId, input.laneId);
  if (!lane) {
    return null;
  }

  const orderedLanes = listProjectLanesByProjectId(db, input.projectId);
  if (!orderedLanes.some((candidate) => candidate.id === input.laneId)) {
    return null;
  }

  const reorderedLanes = orderedLanes.filter((candidate) => candidate.id !== input.laneId);
  const nextIndex = Math.max(0, Math.min(input.position, reorderedLanes.length));
  reorderedLanes.splice(nextIndex, 0, lane);
  if (reorderedLanes.every((candidate, index) => candidate.id === orderedLanes[index]?.id)) {
    return lane;
  }

  const updatedAt = new Date().toISOString();

  reorderedLanes.forEach((candidate, index) => {
    if (candidate.position === index && candidate.id !== lane.id) {
      return;
    }

    db
      .update(lanes)
      .set({
        position: index,
        updatedAt
      })
      .where(eq(lanes.id, candidate.id))
      .run();
  });

  touchProject(db, input.projectId, updatedAt);

  return db.select().from(lanes).where(eq(lanes.id, input.laneId)).get() ?? null;
}

export function deleteOwnedLane(
  db: DatabaseClient,
  input: {
    destinationLaneId?: string;
    laneId: string;
    projectId: string;
    userId: string;
  }
) {
  const project = getOwnedProject(db, input.userId, input.projectId);
  if (!project) {
    return {
      status: "project_not_found" as const
    };
  }

  const lane = getProjectLaneById(db, input.projectId, input.laneId);
  if (!lane) {
    return {
      status: "lane_not_found" as const
    };
  }

  if (isProtectedLaneName(lane.name)) {
    return {
      status: "protected_lane" as const
    };
  }

  const remainingLanes = listProjectLanesByProjectId(db, input.projectId).filter(
    (candidate) => candidate.id !== lane.id
  );
  if (remainingLanes.length === 0) {
    return {
      status: "last_lane" as const
    };
  }

  const destinationLane =
    input.destinationLaneId === undefined
      ? null
      : remainingLanes.find((candidate) => candidate.id === input.destinationLaneId) ?? null;

  if (input.destinationLaneId !== undefined && !destinationLane) {
    return {
      status: "destination_not_found" as const
    };
  }

  const laneTasks = db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, input.projectId), eq(tasks.laneId, lane.id)))
    .orderBy(asc(tasks.position), desc(tasks.updatedAt))
    .all();

  if (laneTasks.length > 0 && !destinationLane) {
    return {
      status: "destination_required" as const
    };
  }

  const updatedAt = new Date().toISOString();

  db.transaction((tx) => {
    if (destinationLane) {
      const sourceTopLevelTaskIds = listSiblingTaskIds(tx, {
        laneId: lane.id,
        parentTaskId: null,
        projectId: input.projectId
      });
      const destinationTopLevelTaskIds = listSiblingTaskIds(tx, {
        laneId: destinationLane.id,
        parentTaskId: null,
        projectId: input.projectId
      });

      tx
        .update(tasks)
        .set({
          laneId: destinationLane.id,
          updatedAt
        })
        .where(and(eq(tasks.projectId, input.projectId), eq(tasks.laneId, lane.id)))
        .run();

      [...destinationTopLevelTaskIds, ...sourceTopLevelTaskIds].forEach((taskId, index) => {
        tx
          .update(tasks)
          .set({
            position: index
          })
          .where(eq(tasks.id, taskId))
          .run();
      });
    }

    tx.delete(lanes).where(eq(lanes.id, lane.id)).run();

    remainingLanes.forEach((candidate, index) => {
      if (candidate.position === index) {
        return;
      }

      tx
        .update(lanes)
        .set({
          position: index,
          updatedAt
        })
        .where(eq(lanes.id, candidate.id))
        .run();
    });

    tx
      .update(projects)
      .set({
        updatedAt
      })
      .where(eq(projects.id, input.projectId))
      .run();
  });

  return {
    status: "deleted" as const
  };
}

export function listTasksForProject(
  db: DatabaseClient,
  input: {
    userId: string;
    projectId: string;
  }
) {
  const project = getOwnedProject(db, input.userId, input.projectId);
  if (!project) {
    return null;
  }

  const taskRows = db
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, input.projectId))
    .all();

  return attachTagsToTasks(db, orderTasksForProject(taskRows, listProjectLanesByProjectId(db, input.projectId)));
}

export function createTask(
  db: DatabaseClient,
  input: {
    userId: string;
    projectId: string;
    title: string;
    body?: string;
    laneId?: string;
    parentTaskId?: string;
    tags?: TaskTagInput[];
  }
) {
  return db.transaction((tx) => {
    const project = getOwnedProject(tx, input.userId, input.projectId);
    if (!project) {
      return {
        status: "project_not_found" as const
      };
    }

    const ticketNumber = project.nextTicketNumber;
    if (ticketNumber === null) {
      throw new Error(`Project ${project.id} is missing nextTicketNumber.`);
    }
    requireProjectTicketPrefix(project);

    const placement = resolveTaskPlacement(tx, {
      laneId: input.laneId,
      parentTaskId: input.parentTaskId,
      projectId: input.projectId
    });
    if (placement.status !== "ok") {
      return {
        status: placement.status
      };
    }

    const parentTaskId = placement.parentTask?.id ?? null;
    const lastPosition = listSiblingTaskIds(tx, {
      laneId: placement.lane.id,
      parentTaskId,
      projectId: input.projectId
    }).length;

    const now = new Date().toISOString();
    const task = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      laneId: placement.lane.id,
      parentTaskId,
      title: input.title,
      body: input.body ?? "",
      ticketNumber,
      position: lastPosition,
      createdAt: now,
      updatedAt: now
    };

    tx.insert(tasks).values(task).run();
    replaceTaskTags(tx, task.id, input.tags ?? []);
    syncTaskTagColorsForUser(tx, input.userId, input.tags);
    tx
      .update(projects)
      .set({
        nextTicketNumber: ticketNumber + 1,
        updatedAt: now
      })
      .where(eq(projects.id, input.projectId))
      .run();

    const createdTask = getTaskWithTags(tx, task.id);
    if (!createdTask) {
      throw new Error(`Failed to load created task ${task.id}.`);
    }

    requireTaskTicketNumber(createdTask);

    return {
      status: "created" as const,
      task: createdTask
    };
  });
}

export function getOwnedTask(
  db: DatabaseClient,
  input: {
    userId: string;
    projectId: string;
    taskId: string;
  }
) {
  const result = db
    .select({ task: tasks })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(
        eq(tasks.id, input.taskId),
        eq(tasks.projectId, input.projectId),
        eq(projects.userId, input.userId)
      )
    )
    .get();

  return result?.task ? attachTagsToTasks(db, [result.task])[0] ?? null : null;
}

export function getOwnedTaskByTicketId(
  db: DatabaseClient,
  input: {
    ticketId: string;
    userId: string;
  }
) {
  const parsedTicketId = parseTicketId(input.ticketId);
  if (!parsedTicketId) {
    return null;
  }

  const result = db
    .select({
      task: tasks,
      ticketPrefix: projects.ticketPrefix
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(
        eq(projects.userId, input.userId),
        eq(projects.ticketPrefix, parsedTicketId.ticketPrefix),
        eq(tasks.ticketNumber, parsedTicketId.ticketNumber)
      )
    )
    .get();

  if (!result?.task || !result.ticketPrefix) {
    return null;
  }

  const task = attachTagsToTasks(db, [result.task])[0];
  if (!task) {
    return null;
  }

  return {
    task,
    ticketPrefix: result.ticketPrefix
  };
}

function reindexTaskGroup(
  db: DatabaseClient,
  input: {
    excludedTaskId?: string;
    laneId: string;
    parentTaskId: string | null;
    projectId: string;
  }
) {
  listSiblingTaskIds(db, input).forEach((taskId, index) => {
    db
      .update(tasks)
      .set({ position: index })
      .where(eq(tasks.id, taskId))
      .run();
  });
}

function resolveDestinationLaneForCrossProjectMove(
  db: DatabaseClient,
  input: {
    destinationProjectId: string;
    sourceLaneName: string;
  }
) {
  const projectLanes = listProjectLanesByProjectId(db, input.destinationProjectId);
  const normalizedSourceLaneName = normalizeLaneName(input.sourceLaneName);

  return (
    projectLanes.find((lane) => normalizeLaneName(lane.name) === normalizedSourceLaneName) ??
    projectLanes.find((lane) => normalizeLaneName(lane.name) === "todo") ??
    projectLanes[0] ??
    null
  );
}

function moveOwnedTaskToProject(
  db: DatabaseClient,
  input: {
    body?: string;
    destinationProjectId: string;
    projectId: string;
    tags?: TaskTagInput[];
    taskId: string;
    title?: string;
    userId: string;
  }
) {
  const task = getOwnedTask(db, input);
  if (!task) {
    return {
      status: "task_not_found" as const
    };
  }

  const sourceProject = getOwnedProject(db, input.userId, input.projectId);
  if (!sourceProject) {
    return {
      status: "task_not_found" as const
    };
  }

  const destinationProject = getOwnedProject(db, input.userId, input.destinationProjectId);
  if (!destinationProject) {
    return {
      status: "destination_project_not_found" as const
    };
  }

  if (!task.laneId) {
    return {
      status: "lane_not_found" as const
    };
  }

  const sourceLane = getProjectLaneById(db, input.projectId, task.laneId);
  if (!sourceLane) {
    return {
      status: "lane_not_found" as const
    };
  }

  const destinationLane = resolveDestinationLaneForCrossProjectMove(db, {
    destinationProjectId: destinationProject.id,
    sourceLaneName: sourceLane.name
  });
  if (!destinationLane) {
    return {
      status: "lane_not_found" as const
    };
  }

  const destinationTicketNumber = destinationProject.nextTicketNumber;
  if (destinationTicketNumber === null) {
    throw new Error(`Project ${destinationProject.id} is missing nextTicketNumber.`);
  }

  requireProjectTicketPrefix(destinationProject);

  const movedChildTaskIds = task.parentTaskId === null ? listChildTaskIds(db, task.id) : [];
  const movedTaskIds = [task.id, ...movedChildTaskIds];
  const destinationTopLevelTaskIds = listSiblingTaskIds(db, {
    laneId: destinationLane.id,
    parentTaskId: null,
    projectId: destinationProject.id
  });
  const destinationTopLevelPosition = destinationTopLevelTaskIds.length;
  const updatedAt = new Date().toISOString();

  reindexTaskGroup(db, {
    excludedTaskId: task.id,
    laneId: task.laneId,
    parentTaskId: task.parentTaskId,
    projectId: input.projectId
  });

  db
    .update(tasks)
    .set({
      body: input.body ?? task.body,
      laneId: destinationLane.id,
      parentTaskId: null,
      position: destinationTopLevelPosition,
      projectId: destinationProject.id,
      ticketNumber: destinationTicketNumber,
      title: input.title ?? task.title,
      updatedAt
    })
    .where(eq(tasks.id, task.id))
    .run();

  movedChildTaskIds.forEach((childTaskId, index) => {
    db
      .update(tasks)
      .set({
        laneId: destinationLane.id,
        position: index,
        projectId: destinationProject.id,
        ticketNumber: destinationTicketNumber + index + 1,
        updatedAt
      })
      .where(eq(tasks.id, childTaskId))
      .run();
  });

  if (input.tags !== undefined) {
    replaceTaskTags(db, task.id, input.tags);
    syncTaskTagColorsForUser(db, input.userId, input.tags);
  }

  db
    .update(projects)
    .set({
      nextTicketNumber: destinationTicketNumber + movedTaskIds.length,
      updatedAt
    })
    .where(eq(projects.id, destinationProject.id))
    .run();
  touchProject(db, sourceProject.id, updatedAt);

  const updatedTask = getTaskWithTags(db, task.id);
  if (!updatedTask) {
    throw new Error(`Failed to load moved task ${task.id}.`);
  }

  requireTaskTicketNumber(updatedTask);

  return {
    status: "updated" as const,
    task: updatedTask
  };
}

export function updateOwnedTask(
  db: DatabaseClient,
  input: {
    body?: string;
    destinationProjectId?: string;
    laneId?: string;
    parentTaskId?: string | null;
    position?: number;
    projectId: string;
    taskId: string;
    tags?: TaskTagInput[];
    title?: string;
    userId: string;
  }
) {
  if (input.destinationProjectId && input.destinationProjectId !== input.projectId) {
    const destinationProjectId = input.destinationProjectId;

    return db.transaction((tx) =>
      moveOwnedTaskToProject(tx, {
        body: input.body,
        destinationProjectId,
        projectId: input.projectId,
        tags: input.tags,
        taskId: input.taskId,
        title: input.title,
        userId: input.userId
      })
    );
  }

  const task = getOwnedTask(db, input);
  if (!task) {
    return {
      status: "task_not_found" as const
    };
  }

  const nextParentTaskIdInput =
    input.parentTaskId === undefined && task.parentTaskId !== null && input.laneId !== undefined
      ? null
      : input.parentTaskId;

  const placement = resolveTaskPlacement(
    db,
    {
      laneId: input.laneId,
      parentTaskId: nextParentTaskIdInput,
      projectId: input.projectId
    },
    task
  );
  if (placement.status !== "ok") {
    return {
      status: placement.status
    };
  }

  const nextParentTaskId = placement.parentTask?.id ?? null;
  const shouldReorder =
    input.position !== undefined ||
    placement.lane.id !== task.laneId ||
    nextParentTaskId !== task.parentTaskId;
  const nextTags = input.tags === undefined ? task.tags : normalizeTaskTags(input.tags);
  if (
    !shouldReorder &&
    (input.title ?? task.title) === task.title &&
    (input.body ?? task.body) === task.body &&
    nextTags.length === task.tags.length &&
    nextTags.every((tag, index) => tag.label === task.tags[index]?.label && tag.color === task.tags[index]?.color)
  ) {
    return {
      status: "updated" as const,
      task
    };
  }

  if (shouldReorder) {
    const laneTaskIds = listSiblingTaskIds(db, {
      excludedTaskId:
        placement.lane.id === task.laneId && nextParentTaskId === task.parentTaskId ? task.id : undefined,
      laneId: placement.lane.id,
      parentTaskId: nextParentTaskId,
      projectId: input.projectId
    });
    const targetPosition = Math.max(
      0,
      Math.min(input.position ?? laneTaskIds.length, laneTaskIds.length)
    );

    reorderTaskSiblings(db, {
      projectId: input.projectId,
      taskId: task.id,
      targetLaneId: placement.lane.id,
      targetParentTaskId: nextParentTaskId,
      targetPosition
    });
  }

  const updatedAt = new Date().toISOString();

  db
    .update(tasks)
    .set({
      body: input.body ?? task.body,
      laneId: placement.lane.id,
      parentTaskId: nextParentTaskId,
      title: input.title ?? task.title,
      updatedAt
    })
    .where(eq(tasks.id, task.id))
    .run();

  if (task.parentTaskId === null && placement.lane.id !== task.laneId) {
    moveSubtasksToLane(db, task.id, placement.lane.id, updatedAt);
  }

  if (input.tags !== undefined) {
    replaceTaskTags(db, task.id, input.tags);
    syncTaskTagColorsForUser(db, input.userId, input.tags);
  }

  touchProject(db, input.projectId, updatedAt);
  const updatedTask = getTaskWithTags(db, task.id);
  if (!updatedTask) {
    throw new Error(`Failed to load updated task ${task.id}.`);
  }

  return {
    status: "updated" as const,
    task: updatedTask
  };
}

export function deleteOwnedTask(
  db: DatabaseClient,
  input: {
    projectId: string;
    taskId: string;
    userId: string;
  }
) {
  const task = getOwnedTask(db, input);
  if (!task) {
    return false;
  }

  const updatedAt = new Date().toISOString();
  const childTaskIds = listChildTaskIds(db, task.id);

  db.transaction((tx) => {
    if (!task.laneId) {
      tx.delete(tasks).where(eq(tasks.id, task.id)).run();
    } else if (task.parentTaskId !== null) {
      tx.delete(tasks).where(eq(tasks.id, task.id)).run();

      listSiblingTaskIds(tx, {
        laneId: task.laneId,
        parentTaskId: task.parentTaskId,
        projectId: input.projectId
      }).forEach((taskId, index) => {
        tx
          .update(tasks)
          .set({ position: index })
          .where(eq(tasks.id, taskId))
          .run();
      });
    } else if (childTaskIds.length > 0) {
      const topLevelTaskIds = listSiblingTaskIds(tx, {
        excludedTaskId: task.id,
        laneId: task.laneId,
        parentTaskId: null,
        projectId: input.projectId
      });
      const insertIndex = Math.max(0, Math.min(task.position, topLevelTaskIds.length));

      tx
        .update(tasks)
        .set({
          parentTaskId: null,
          updatedAt
        })
        .where(eq(tasks.parentTaskId, task.id))
        .run();

      topLevelTaskIds.splice(insertIndex, 0, ...childTaskIds);
      topLevelTaskIds.forEach((taskId, index) => {
        tx
          .update(tasks)
          .set({ position: index })
          .where(eq(tasks.id, taskId))
          .run();
      });

      tx.delete(tasks).where(eq(tasks.id, task.id)).run();
    } else {
      tx.delete(tasks).where(eq(tasks.id, task.id)).run();

      listSiblingTaskIds(tx, {
        laneId: task.laneId,
        parentTaskId: null,
        projectId: input.projectId
      }).forEach((taskId, index) => {
        tx
          .update(tasks)
          .set({ position: index })
          .where(eq(tasks.id, taskId))
          .run();
      });
    }

    tx
      .update(projects)
      .set({
        updatedAt
      })
      .where(eq(projects.id, input.projectId))
      .run();
  });

  return true;
}
