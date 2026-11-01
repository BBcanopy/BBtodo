import { type Page, type Route } from "@playwright/test";

import {
  type ApiTokenSummary,
  type BoardLane,
  type Project,
  type Task,
  type TaskTag,
  type TaskTagColor,
  type TodoProjectGroup,
  type UserTheme
} from "../../web/src/api";

type DefaultLaneKey = "todo" | "in_progress" | "in_review" | "done";

const bootstrappedPages = new WeakSet<Page>();
const reducedMotionStyleId = "bbtodo-e2e-reduced-motion";
const reducedMotionCss = `
  *,
  *::before,
  *::after {
    animation-delay: 0ms !important;
    animation-duration: 0ms !important;
    transition-delay: 0ms !important;
    transition-duration: 0ms !important;
    scroll-behavior: auto !important;
  }
`;

const user = {
  email: "operator@example.com",
  id: "user-1",
  name: "Nadia Vale",
  theme: "sea" as UserTheme
};

export const tag = (label: string, color: TaskTagColor = "moss"): TaskTag => ({
  color,
  label
});

export function laneId(projectId: string, suffix: DefaultLaneKey) {
  return `${projectId}-lane-${suffix}`;
}

function normalizeLaneName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function isDoneLaneName(value: string) {
  return normalizeLaneName(value) === "done";
}

function isProtectedLaneName(value: string) {
  const normalizedLaneName = normalizeLaneName(value);
  return normalizedLaneName === "todo" || normalizedLaneName === "done";
}

function compareTasksInLane(left: Task, right: Task, isDoneLane: boolean) {
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

function createDefaultLaneSummaries(
  projectId: string,
  counts: Record<DefaultLaneKey, number>
): BoardLane[] {
  return [
    {
      createdAt: "2026-03-17T09:00:00.000Z",
      id: laneId(projectId, "todo"),
      name: "Todo",
      position: 0,
      projectId,
      taskCount: counts.todo,
      updatedAt: "2026-03-18T07:30:00.000Z"
    },
    {
      createdAt: "2026-03-17T09:00:00.000Z",
      id: laneId(projectId, "in_progress"),
      name: "In Progress",
      position: 1,
      projectId,
      taskCount: counts.in_progress,
      updatedAt: "2026-03-18T07:30:00.000Z"
    },
    {
      createdAt: "2026-03-17T09:00:00.000Z",
      id: laneId(projectId, "in_review"),
      name: "In review",
      position: 2,
      projectId,
      taskCount: counts.in_review,
      updatedAt: "2026-03-18T07:30:00.000Z"
    },
    {
      createdAt: "2026-03-17T09:00:00.000Z",
      id: laneId(projectId, "done"),
      name: "Done",
      position: 3,
      projectId,
      taskCount: counts.done,
      updatedAt: "2026-03-18T07:30:00.000Z"
    }
  ];
}

const generatedTicketPrefixLetters = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
const generatedTicketPrefixLength = 4;
const totalGeneratedTicketPrefixCount = generatedTicketPrefixLetters.length ** generatedTicketPrefixLength;

function toFixtureTicketPrefixStem(name: string) {
  return name.normalize("NFKD").replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 4);
}

function encodeGeneratedTicketPrefix(index: number) {
  let remaining = index;
  let prefix = "";

  for (let digitIndex = 0; digitIndex < generatedTicketPrefixLength; digitIndex += 1) {
    prefix = `${generatedTicketPrefixLetters[remaining % generatedTicketPrefixLetters.length]}${prefix}`;
    remaining = Math.floor(remaining / generatedTicketPrefixLetters.length);
  }

  return prefix;
}

function findAvailableGeneratedTicketPrefix(usedPrefixes: Set<string>) {
  if (usedPrefixes.size >= totalGeneratedTicketPrefixCount) {
    throw new Error("No unique project ticket prefix is available for e2e fixtures.");
  }

  for (let index = 0; index < totalGeneratedTicketPrefixCount; index += 1) {
    const candidate = encodeGeneratedTicketPrefix(index);
    if (!usedPrefixes.has(candidate)) {
      return candidate;
    }
  }

  throw new Error("No unique project ticket prefix is available for e2e fixtures.");
}

function allocateFixtureTicketPrefix(name: string, usedPrefixes: Set<string>) {
  // Keep the browser mock lightweight: seeded tasks define their own prefixes,
  // and newly created projects only need a stable unique prefix for UI coverage.
  const stem = toFixtureTicketPrefixStem(name);

  if (stem.length >= 2 && !usedPrefixes.has(stem)) {
    return stem;
  }

  if (stem.length === 1) {
    const paddedStem = `${stem}X`;
    if (!usedPrefixes.has(paddedStem)) {
      return paddedStem;
    }
  }

  return findAvailableGeneratedTicketPrefix(usedPrefixes);
}

function parseTicketNumber(ticketId: string) {
  const match = ticketId.match(/-(\d+)$/);
  return match ? Number(match[1]) : null;
}

function parseTicketPrefix(ticketId: string) {
  const match = ticketId.match(/^([A-Z]{2,4})-\d+$/);
  return match ? match[1] : null;
}

export const projects: Project[] = [
  {
    archived: false,
    createdAt: "2026-03-17T09:00:00.000Z",
    id: "project-1",
    laneSummaries: createDefaultLaneSummaries("project-1", {
      todo: 2,
      in_progress: 1,
      in_review: 0,
      done: 1
    }),
    name: "Billing cleanup",
    ticketPrefix: "BILL",
    updatedAt: "2026-03-18T07:30:00.000Z"
  }
];

export const projectsForGrid: Project[] = [
  ...projects,
  {
    createdAt: "2026-03-17T10:00:00.000Z",
    id: "project-2",
    archived: false,
    laneSummaries: createDefaultLaneSummaries("project-2", {
      todo: 0,
      in_progress: 0,
      in_review: 0,
      done: 0
    }),
    name: "Roadmap review",
    ticketPrefix: "ROAD",
    updatedAt: "2026-03-18T08:10:00.000Z"
  },
  {
    createdAt: "2026-03-17T11:00:00.000Z",
    id: "project-3",
    archived: false,
    laneSummaries: createDefaultLaneSummaries("project-3", {
      todo: 2,
      in_progress: 1,
      in_review: 0,
      done: 0
    }),
    name: "Release prep",
    ticketPrefix: "RELE",
    updatedAt: "2026-03-18T08:20:00.000Z"
  },
  {
    createdAt: "2026-03-17T12:00:00.000Z",
    id: "project-4",
    archived: false,
    laneSummaries: createDefaultLaneSummaries("project-4", {
      todo: 1,
      in_progress: 0,
      in_review: 0,
      done: 3
    }),
    name: "Customer follow-up",
    ticketPrefix: "CUST",
    updatedAt: "2026-03-18T08:30:00.000Z"
  },
  {
    createdAt: "2026-03-17T12:30:00.000Z",
    id: "project-5",
    archived: false,
    laneSummaries: createDefaultLaneSummaries("project-5", {
      todo: 3,
      in_progress: 1,
      in_review: 0,
      done: 0
    }),
    name: "Support triage",
    ticketPrefix: "SUPP",
    updatedAt: "2026-03-18T08:40:00.000Z"
  },
  {
    createdAt: "2026-03-17T13:00:00.000Z",
    id: "project-6",
    archived: false,
    laneSummaries: createDefaultLaneSummaries("project-6", {
      todo: 1,
      in_progress: 2,
      in_review: 0,
      done: 2
    }),
    name: "Partner audit",
    ticketPrefix: "PART",
    updatedAt: "2026-03-18T08:50:00.000Z"
  }
];

export const tasks: Task[] = [
  {
    body: "Callback logs mention **retry** scope.",
    createdAt: "2026-03-18T07:00:00.000Z",
    id: "task-1",
    laneId: laneId("project-1", "todo"),
    parentTaskId: null,
    position: 0,
    projectId: "project-1",
    ticketId: "BILL-1",
    tags: [tag("backend", "sky"), tag("retry", "coral")],
    title: "Review retry settings",
    updatedAt: "2026-03-18T07:10:00.000Z"
  },
  {
    body: "Capture OIDC callback details for the new deployment.",
    createdAt: "2026-03-18T07:20:00.000Z",
    id: "task-2",
    laneId: laneId("project-1", "in_progress"),
    parentTaskId: null,
    position: 0,
    projectId: "project-1",
    ticketId: "BILL-2",
    tags: [tag("observability", "slate"), tag("oidc", "orchid")],
    title: "Tighten callback logging",
    updatedAt: "2026-03-18T07:45:00.000Z"
  },
  {
    body: "Docker compose no longer pings health forever.",
    createdAt: "2026-03-18T06:50:00.000Z",
    id: "task-3",
    laneId: laneId("project-1", "done"),
    parentTaskId: null,
    position: 0,
    projectId: "project-1",
    ticketId: "BILL-3",
    tags: [tag("ops", "amber")],
    title: "Remove healthcheck loop",
    updatedAt: "2026-03-18T07:50:00.000Z"
  },
  {
    body: "Queue the copy pass after retry scope lands.",
    createdAt: "2026-03-18T07:05:00.000Z",
    id: "task-4",
    laneId: laneId("project-1", "todo"),
    parentTaskId: null,
    position: 1,
    projectId: "project-1",
    ticketId: "BILL-4",
    tags: [tag("copy", "moss")],
    title: "Queue copy pass",
    updatedAt: "2026-03-18T07:15:00.000Z"
  }
];

async function fulfillJson(route: Route, status: number, body: unknown) {
  await route.fulfill({
    body: JSON.stringify(body),
    contentType: "application/json",
    status
  });
}

async function bootstrapPage(page: Page, disableAnimations = true) {
  if (bootstrappedPages.has(page)) {
    return;
  }

  bootstrappedPages.add(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  if (!disableAnimations) {
    return;
  }

  await page.addInitScript(
    ({ cssText, styleId }: { cssText: string; styleId: string }) => {
      function ensureReducedMotionStyle() {
        if (document.getElementById(styleId)) {
          return;
        }

        const parent = document.head ?? document.documentElement;
        if (!parent) {
          return;
        }

        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = cssText;
        parent.append(style);
      }

      ensureReducedMotionStyle();

      if (!document.getElementById(styleId) && document.documentElement) {
        const observer = new MutationObserver(() => {
          ensureReducedMotionStyle();
          if (document.getElementById(styleId)) {
            observer.disconnect();
          }
        });

        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
    },
    { cssText: reducedMotionCss, styleId: reducedMotionStyleId }
  );
}

export async function mockUnauthenticated(page: Page) {
  await bootstrapPage(page);
  await page.route("**/api/v1/me", async (route) => {
    await fulfillJson(route, 401, { message: "Unauthorized" });
  });
}

export async function mockAuthenticated(
  page: Page,
  options?: {
    apiTokens?: ApiTokenSummary[];
    deleteProjectDelayMs?: number;
    disableAnimations?: boolean;
    nextApiTokenId?: number;
    nextProjectId?: number;
    projects?: Project[];
    taskPatchDelayMs?: number;
    taskPatchFailuresById?: Record<string, number>;
    taskMoveDelayMs?: number;
    tasks?: Task[];
  }
) {
  await bootstrapPage(page, options?.disableAnimations);
  let nextApiTokenId = options?.nextApiTokenId ?? 1;
  let nextProjectId = options?.nextProjectId ?? 2;
  let nextLaneId = 1;
  let nextTaskId = 5;
  const deleteProjectDelayMs = options?.deleteProjectDelayMs ?? 0;
  const taskPatchDelayMs = options?.taskPatchDelayMs ?? 0;
  const taskPatchFailuresById = new Map(
    Object.entries(options?.taskPatchFailuresById ?? {}).map(([taskId, remaining]) => [
      taskId,
      remaining
    ])
  );
  const taskMoveDelayMs = options?.taskMoveDelayMs ?? 0;
  let isAuthenticated = true;
  const currentUser = structuredClone(user);
  const apiTokenState = (options?.apiTokens ?? []).map((token) => structuredClone(token));
  const projectState = (options?.projects ?? projects).map((project) => structuredClone(project));
  const taskState = (options?.tasks ?? tasks).map((task) => structuredClone(task));
  const projectTicketPrefixes = new Map<string, string>();
  const nextTicketNumbers = new Map<string, number>();

  function syncProjectTicketState() {
    const usedPrefixes = new Set<string>();

    [...projectState]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .forEach((project) => {
        const existingPrefix = project.ticketPrefix ?? projectTicketPrefixes.get(project.id);
        if (existingPrefix) {
          projectTicketPrefixes.set(project.id, existingPrefix);
          usedPrefixes.add(existingPrefix);
          return;
        }

        const seededPrefixes = new Set(
          taskState
            .filter((task) => task.projectId === project.id)
            .map((task) => parseTicketPrefix(task.ticketId))
            .filter((prefix): prefix is string => prefix !== null)
        );

        if (seededPrefixes.size > 1) {
          throw new Error(`Expected a single seeded ticket prefix for project ${project.id}.`);
        }

        const resolvedPrefix =
          seededPrefixes.size === 1
            ? (seededPrefixes.values().next().value as string)
            : allocateFixtureTicketPrefix(project.name, usedPrefixes);

        projectTicketPrefixes.set(project.id, resolvedPrefix);
        project.ticketPrefix = resolvedPrefix;
        usedPrefixes.add(resolvedPrefix);
      });

    projectState.forEach((project) => {
      const prefix = projectTicketPrefixes.get(project.id);
      if (!prefix) {
        throw new Error(`Expected ticket prefix state for project ${project.id}.`);
      }

      project.ticketPrefix = prefix;

      let highestTicketNumber = 0;

      [...taskState]
        .filter((task) => task.projectId === project.id)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
        .forEach((task) => {
          const parsedTicketNumber = parseTicketNumber(task.ticketId);
          if (parsedTicketNumber !== null) {
            highestTicketNumber = Math.max(highestTicketNumber, parsedTicketNumber);
            return;
          }

          highestTicketNumber += 1;
          task.ticketId = `${prefix}-${highestTicketNumber}`;
        });

      const currentNextTicketNumber = nextTicketNumbers.get(project.id) ?? 1;
      nextTicketNumbers.set(project.id, Math.max(currentNextTicketNumber, highestTicketNumber + 1, 1));
    });
  }

  function getProject(projectId: string) {
    return projectState.find((project) => project.id === projectId) ?? null;
  }

  function getProjectByTicketPrefix(ticketPrefix: string) {
    return projectState.find((project) => project.ticketPrefix === ticketPrefix) ?? null;
  }

  function getProjectTicketPrefix(projectId: string) {
    return projectTicketPrefixes.get(projectId) ?? getProject(projectId)?.ticketPrefix ?? "XX";
  }

  function allocateNextTicketId(projectId: string) {
    const nextTicketNumber = nextTicketNumbers.get(projectId) ?? 1;
    nextTicketNumbers.set(projectId, nextTicketNumber + 1);
    return `${getProjectTicketPrefix(projectId)}-${nextTicketNumber}`;
  }

  function syncProject(projectId: string) {
    const project = getProject(projectId);
    if (!project) {
      return;
    }

    project.laneSummaries = [...project.laneSummaries]
      .sort((left, right) => left.position - right.position)
      .map((lane) => ({
        ...lane,
        taskCount: taskState.filter((task) => task.projectId === projectId && task.laneId === lane.id).length
      }));
  }

  function getLane(projectId: string, laneIdValue: string) {
    return getProject(projectId)?.laneSummaries.find((lane) => lane.id === laneIdValue) ?? null;
  }

  function listSiblingTasks(
    projectId: string,
    laneIdValue: string,
    parentTaskId: string | null,
    excludedTaskId?: string
  ) {
    return taskState
      .filter(
        (task) =>
          task.projectId === projectId &&
        task.id !== excludedTaskId &&
        task.laneId === laneIdValue &&
        task.parentTaskId === parentTaskId
      )
      .sort((left, right) =>
        compareTasksInLane(left, right, isDoneLaneName(getLane(projectId, laneIdValue)?.name ?? ""))
      );
  }

  function listChildTasks(projectId: string, parentTaskId: string) {
    const childTasks = taskState.filter((task) => task.projectId === projectId && task.parentTaskId === parentTaskId);
    const laneName = childTasks[0]?.laneId ? getLane(projectId, childTasks[0].laneId)?.name ?? "" : "";

    return childTasks.sort((left, right) => compareTasksInLane(left, right, isDoneLaneName(laneName)));
  }

  function taskHasChildren(projectId: string, taskId: string) {
    return taskState.some((task) => task.projectId === projectId && task.parentTaskId === taskId);
  }

  function listTasksForBoard(projectId: string) {
    const project = getProject(projectId);
    if (!project) {
      return [];
    }

    const orderedTasks: Task[] = [];

    [...project.laneSummaries]
      .sort((left, right) => left.position - right.position)
      .forEach((lane) => {
        listSiblingTasks(projectId, lane.id, null).forEach((task) => {
          orderedTasks.push(task);
          listChildTasks(projectId, task.id).forEach((childTask) => orderedTasks.push(childTask));
        });
      });

    return orderedTasks;
  }

  function listTodoGroups() {
    syncAllProjects();

    return projectState.flatMap((project) => {
      if (project.archived) {
        return [];
      }
      const todoLane = project.laneSummaries.find((lane) => normalizeLaneName(lane.name) === "todo");
      if (!todoLane) {
        return [];
      }

      const todoTasks = listTasksForBoard(project.id).filter((task) => task.laneId === todoLane.id);
      if (todoTasks.length === 0) {
        return [];
      }

      return [
        {
          projectId: project.id,
          projectName: project.name,
          projectTicketPrefix: project.ticketPrefix,
          tasks: todoTasks
        } satisfies TodoProjectGroup
      ];
    });
  }

  function syncAllProjects() {
    projectState.forEach((project) => syncProject(project.id));
  }

  function listReusableTags() {
    const tagsByKey = new Map<string, TaskTag>();

    [...taskState]
      .sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1))
      .forEach((task) => {
        task.tags.forEach((taskTag) => {
          const key = taskTag.label.trim().toLowerCase();
          if (!key || tagsByKey.has(key)) {
            return;
          }

          tagsByKey.set(key, taskTag);
        });
      });

    return Array.from(tagsByKey.values()).sort((left, right) =>
      left.label.localeCompare(right.label, undefined, { sensitivity: "base" })
    );
  }

  function syncReusableTagColors(nextTags: TaskTag[]) {
    const colorsByKey = new Map(
      nextTags
        .map((taskTag) => [taskTag.label.trim().toLowerCase(), taskTag.color] as const)
        .filter(([key]) => key.length > 0)
    );
    if (colorsByKey.size === 0) {
      return;
    }

    taskState.forEach((task) => {
      task.tags = task.tags.map((taskTag) => {
        const nextColor = colorsByKey.get(taskTag.label.trim().toLowerCase());
        if (!nextColor || nextColor === taskTag.color) {
          return taskTag;
        }

        return {
          ...taskTag,
          color: nextColor
        };
      });
    });
  }

  function reindexTaskGroup(
    projectId: string,
    laneIdValue: string,
    parentTaskId: string | null,
    excludedTaskId?: string
  ) {
    listSiblingTasks(projectId, laneIdValue, parentTaskId, excludedTaskId).forEach((task, index) => {
      task.position = index;
    });
  }

  function resolveCrossProjectDestinationLane(destinationProjectId: string, sourceLaneName: string) {
    const destinationProject = getProject(destinationProjectId);
    if (!destinationProject) {
      return null;
    }

    return (
      destinationProject.laneSummaries.find(
        (lane) => normalizeLaneName(lane.name) === normalizeLaneName(sourceLaneName)
      ) ??
      destinationProject.laneSummaries.find((lane) => normalizeLaneName(lane.name) === "todo") ??
      destinationProject.laneSummaries[0] ??
      null
    );
  }

  function moveTaskToProject(task: Task, destinationProjectId: string) {
    if (!task.laneId) {
      return { status: "lane_not_found" as const };
    }

    const destinationProject = getProject(destinationProjectId);
    if (!destinationProject) {
      return { status: "destination_project_not_found" as const };
    }

    const sourceProjectId = task.projectId;
    const sourceLane = getLane(sourceProjectId, task.laneId);
    if (!sourceLane) {
      return { status: "lane_not_found" as const };
    }

    const destinationLane = resolveCrossProjectDestinationLane(destinationProjectId, sourceLane.name);
    if (!destinationLane) {
      return { status: "lane_not_found" as const };
    }

    const updatedAt = "2026-03-18T08:05:00.000Z";
    const movedChildTasks = task.parentTaskId === null ? listChildTasks(sourceProjectId, task.id) : [];

    reindexTaskGroup(sourceProjectId, task.laneId, task.parentTaskId, task.id);

    task.projectId = destinationProjectId;
    task.laneId = destinationLane.id;
    task.parentTaskId = null;
    task.position = listSiblingTasks(destinationProjectId, destinationLane.id, null).length;
    task.ticketId = allocateNextTicketId(destinationProjectId);
    task.updatedAt = updatedAt;

    movedChildTasks.forEach((childTask, index) => {
      childTask.projectId = destinationProjectId;
      childTask.laneId = destinationLane.id;
      childTask.position = index;
      childTask.ticketId = allocateNextTicketId(destinationProjectId);
      childTask.updatedAt = updatedAt;
    });

    syncProject(sourceProjectId);
    syncProject(destinationProjectId);

    return {
      status: "moved" as const,
      task
    };
  }

  function moveTask(
    task: Task,
    targetLaneId: string,
    targetParentTaskId: string | null,
    targetPosition: number
  ) {
    if (!task.laneId) {
      return;
    }

    const sourceLaneId = task.laneId;
    const sourceParentTaskId = task.parentTaskId;
    const sourceSiblings = listSiblingTasks(task.projectId, sourceLaneId, sourceParentTaskId, task.id);
    const targetSiblings = listSiblingTasks(task.projectId, targetLaneId, targetParentTaskId, task.id);
    const clampedPosition = Math.max(0, Math.min(targetPosition, targetSiblings.length));

    sourceSiblings.forEach((candidate, index) => {
      candidate.position = index;
    });

    const reorderedTargets = [...targetSiblings];
    reorderedTargets.splice(clampedPosition, 0, task);
    reorderedTargets.forEach((candidate, index) => {
      candidate.laneId = targetLaneId;
      candidate.parentTaskId = candidate.id === task.id ? targetParentTaskId : candidate.parentTaskId;
      candidate.position = index;
    });

    if (task.parentTaskId === null && sourceLaneId !== targetLaneId) {
      listChildTasks(task.projectId, task.id).forEach((childTask) => {
        childTask.laneId = targetLaneId;
      });
    }
  }

  function moveLane(projectId: string, laneIdValue: string, targetPosition: number) {
    const project = getProject(projectId);
    if (!project) {
      return null;
    }

    const lane = project.laneSummaries.find((candidate) => candidate.id === laneIdValue);
    if (!lane) {
      return null;
    }

    const orderedLanes = [...project.laneSummaries].sort((left, right) => left.position - right.position);
    const reorderedLanes = orderedLanes.filter((candidate) => candidate.id !== laneIdValue);
    const clampedPosition = Math.max(0, Math.min(targetPosition, reorderedLanes.length));
    reorderedLanes.splice(clampedPosition, 0, lane);
    reorderedLanes.forEach((candidate, index) => {
      candidate.position = index;
      candidate.updatedAt = "2026-03-18T08:12:00.000Z";
    });

    project.laneSummaries = reorderedLanes;
    syncProject(projectId);
    return project.laneSummaries.find((candidate) => candidate.id === laneIdValue) ?? null;
  }

  function deleteLane(projectId: string, laneIdValue: string, destinationLaneId?: string) {
    const project = getProject(projectId);
    if (!project) {
      return { status: "project_not_found" as const };
    }

    const lane = project.laneSummaries.find((candidate) => candidate.id === laneIdValue);
    if (!lane) {
      return { status: "lane_not_found" as const };
    }

    if (isProtectedLaneName(lane.name)) {
      return { status: "protected_lane" as const };
    }

    const remainingLanes = project.laneSummaries
      .filter((candidate) => candidate.id !== laneIdValue)
      .sort((left, right) => left.position - right.position);
    if (remainingLanes.length === 0) {
      return { status: "last_lane" as const };
    }

    const destinationLane =
      destinationLaneId === undefined
        ? null
        : remainingLanes.find((candidate) => candidate.id === destinationLaneId) ?? null;

    if (destinationLaneId !== undefined && !destinationLane) {
      return { status: "destination_not_found" as const };
    }

    const laneTasks = taskState.filter((task) => task.projectId === projectId && task.laneId === laneIdValue);
    if (laneTasks.length > 0 && !destinationLane) {
      return { status: "destination_required" as const };
    }

    if (destinationLane) {
      const sourceTopLevelTasks = listSiblingTasks(projectId, laneIdValue, null);
      const destinationTopLevelTasks = listSiblingTasks(projectId, destinationLane.id, null);

      laneTasks.forEach((task) => {
        task.laneId = destinationLane.id;
        task.updatedAt = "2026-03-18T08:16:00.000Z";
      });

      [...destinationTopLevelTasks, ...sourceTopLevelTasks].forEach((task, index) => {
        task.position = index;
      });
    }

    project.laneSummaries = remainingLanes.map((candidate, index) => ({
      ...candidate,
      position: index,
      updatedAt: "2026-03-18T08:16:00.000Z"
    }));
    syncProject(projectId);

    return { status: "deleted" as const };
  }

  syncProjectTicketState();
  syncAllProjects();

  await page.route("**/auth/logout", async (route) => {
    isAuthenticated = false;
    await fulfillJson(route, 200, null);
  });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;
    const body = request.postDataJSON() as
      | {
          body?: string;
          archived?: boolean;
          destinationLaneId?: string;
          laneId?: string;
          name?: string;
          parentTaskId?: string | null;
          position?: number;
          tags?: TaskTag[];
          theme?: UserTheme;
          title?: string;
        }
      | null;

    switch (key) {
      case "GET /api/v1/me":
        if (!isAuthenticated) {
          await fulfillJson(route, 401, { message: "Unauthorized" });
          return;
        }

        await fulfillJson(route, 200, currentUser);
        return;
      case "PATCH /api/v1/me/theme":
        currentUser.theme = body?.theme ?? currentUser.theme;
        await fulfillJson(route, 200, currentUser);
        return;
      case "GET /api/v1/projects":
        syncAllProjects();
        await fulfillJson(route, 200, projectState.filter(
          (project) => url.searchParams.get("includeArchived") === "true" || !project.archived
        ));
        return;
      case "GET /api/v1/todos":
        await fulfillJson(route, 200, listTodoGroups());
        return;
      case "GET /api/v1/task-tags":
        await fulfillJson(route, 200, listReusableTags());
        return;
      case "GET /api/v1/api-tokens":
        await fulfillJson(route, 200, apiTokenState);
        return;
      case "POST /api/v1/api-tokens": {
        const createdToken: ApiTokenSummary = {
          createdAt: "2026-03-18T08:28:00.000Z",
          id: `token-${nextApiTokenId++}`,
          lastUsedAt: null,
          name: body?.name ?? "Untitled token"
        };
        apiTokenState.unshift(createdToken);
        await fulfillJson(route, 201, {
          token: `bbtodo_${createdToken.id}`,
          tokenInfo: createdToken
        });
        return;
      }
      case "POST /api/v1/projects": {
        const createdProjectId = `project-${nextProjectId++}`;
        const projectName = body?.title ?? body?.name ?? "Untitled board";
        const resolvedPrefix = allocateFixtureTicketPrefix(projectName, new Set(projectTicketPrefixes.values()));

        const createdProject: Project = {
          archived: false,
          createdAt: "2026-03-18T08:00:00.000Z",
          id: createdProjectId,
          laneSummaries: createDefaultLaneSummaries(createdProjectId, {
            todo: 0,
            in_progress: 0,
            in_review: 0,
            done: 0
          }),
          name: projectName,
          ticketPrefix: resolvedPrefix,
          updatedAt: "2026-03-18T08:00:00.000Z"
        };
        projectState.unshift(createdProject);
        projectTicketPrefixes.set(createdProject.id, resolvedPrefix);
        nextTicketNumbers.set(createdProject.id, 1);
        await fulfillJson(route, 201, createdProject);
        return;
      }
      case "PATCH /api/v1/projects":
        await fulfillJson(route, 404, { message: "Project not found." });
        return;
      default:
        break;
    }

    if (request.method() === "DELETE" && url.pathname.startsWith("/api/v1/api-tokens/")) {
      const tokenId = url.pathname.split("/").pop() ?? "";
      const tokenIndex = apiTokenState.findIndex((candidate) => candidate.id === tokenId);

      if (tokenIndex === -1) {
        await fulfillJson(route, 404, { message: "Token not found." });
        return;
      }

      apiTokenState.splice(tokenIndex, 1);
      await fulfillJson(route, 204, null);
      return;
    }

    if (request.method() === "GET" && url.pathname.startsWith("/api/v1/projects/") && url.pathname.endsWith("/lanes")) {
      const projectId = url.pathname.split("/")[4];
      const project = getProject(projectId);
      if (!project) {
        await fulfillJson(route, 404, { message: "Project not found." });
        return;
      }

      syncProject(projectId);
      await fulfillJson(route, 200, project.laneSummaries);
      return;
    }

    if (request.method() === "GET" && url.pathname.startsWith("/api/v1/projects/by-ticket-prefix/")) {
      const ticketPrefix = url.pathname.split("/").pop() ?? "";
      const project = getProjectByTicketPrefix(ticketPrefix);
      if (!project) {
        await fulfillJson(route, 404, { message: "Project not found." });
        return;
      }

      syncProject(project.id);
      await fulfillJson(route, 200, project);
      return;
    }

    if (request.method() === "GET" && url.pathname.startsWith("/api/v1/tasks/by-ticket/")) {
      const ticketId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const task = taskState.find((candidate) => candidate.ticketId === ticketId);
      if (!task) {
        await fulfillJson(route, 404, { message: "Task not found." });
        return;
      }

      await fulfillJson(route, 200, task);
      return;
    }

    if (request.method() === "POST" && url.pathname.startsWith("/api/v1/projects/") && url.pathname.endsWith("/lanes")) {
      const projectId = url.pathname.split("/")[4];
      const project = getProject(projectId);
      if (!project) {
        await fulfillJson(route, 404, { message: "Project not found." });
        return;
      }

      const createdLane: BoardLane = {
        createdAt: "2026-03-18T08:15:00.000Z",
        id: `${projectId}-lane-custom-${nextLaneId++}`,
        name: body?.name ?? "New Lane",
        position: project.laneSummaries.length,
        projectId,
        taskCount: 0,
        updatedAt: "2026-03-18T08:15:00.000Z"
      };
      project.laneSummaries.push(createdLane);
      syncProject(projectId);
      await fulfillJson(route, 201, createdLane);
      return;
    }

    if (request.method() === "PATCH" && url.pathname.startsWith("/api/v1/projects/") && url.pathname.includes("/lanes/")) {
      const [projectId, laneIdValue] = [url.pathname.split("/")[4], url.pathname.split("/").pop() ?? ""];
      const lane = moveLane(projectId, laneIdValue, body?.position ?? 0);

      if (!lane) {
        await fulfillJson(route, 404, { message: "Lane not found." });
        return;
      }

      await fulfillJson(route, 200, lane);
      return;
    }

    if (request.method() === "DELETE" && url.pathname.startsWith("/api/v1/projects/") && url.pathname.includes("/lanes/")) {
      const [projectId, laneIdValue] = [url.pathname.split("/")[4], url.pathname.split("/").pop() ?? ""];
      const deleted = deleteLane(projectId, laneIdValue, body?.destinationLaneId);

      if (deleted.status === "project_not_found" || deleted.status === "lane_not_found") {
        await fulfillJson(route, 404, {
          message: deleted.status === "project_not_found" ? "Project not found." : "Lane not found."
        });
        return;
      }

      if (deleted.status === "last_lane") {
        await fulfillJson(route, 400, { message: "Projects must keep at least one lane." });
        return;
      }

      if (deleted.status === "protected_lane") {
        await fulfillJson(route, 400, { message: "Todo and Done lanes cannot be deleted." });
        return;
      }

      if (deleted.status === "destination_required") {
        await fulfillJson(route, 400, { message: "Select a destination lane before deleting this lane." });
        return;
      }

      if (deleted.status === "destination_not_found") {
        await fulfillJson(route, 400, { message: "Destination lane not found." });
        return;
      }

      await fulfillJson(route, 204, null);
      return;
    }

    if (
      request.method() === "PATCH" &&
      url.pathname.startsWith("/api/v1/projects/") &&
      !url.pathname.includes("/lanes/") &&
      !url.pathname.includes("/tasks/")
    ) {
      const projectId = url.pathname.split("/").pop() ?? "";
      const project = getProject(projectId);
      if (!project) {
        await fulfillJson(route, 404, { message: "Project not found." });
        return;
      }

      project.name = body?.name ?? project.name;
      project.archived = body?.archived ?? project.archived;
      project.updatedAt = "2026-03-18T08:12:00.000Z";
      syncProject(projectId);
      await fulfillJson(route, 200, project);
      return;
    }

    if (request.method() === "GET" && url.pathname.startsWith("/api/v1/projects/") && url.pathname.endsWith("/tasks")) {
      const projectId = url.pathname.split("/")[4];
      const project = getProject(projectId);
      if (!project) {
        await fulfillJson(route, 404, { message: "Project not found." });
        return;
      }

      await fulfillJson(route, 200, listTasksForBoard(projectId));
      return;
    }

    if (request.method() === "POST" && url.pathname.startsWith("/api/v1/projects/") && url.pathname.endsWith("/tasks")) {
      const projectId = url.pathname.split("/")[4];
      const project = getProject(projectId);
      if (!project) {
        await fulfillJson(route, 404, { message: "Project or lane not found." });
        return;
      }

      const parentTask =
        body?.parentTaskId === undefined
          ? null
          : taskState.find(
              (candidate) => candidate.projectId === projectId && candidate.id === body.parentTaskId
            ) ?? null;

      if (body?.parentTaskId !== undefined && !parentTask) {
        await fulfillJson(route, 404, { message: "Parent task not found." });
        return;
      }

      if (parentTask && parentTask.parentTaskId !== null) {
        await fulfillJson(route, 400, { message: "Subtasks can only be added under top-level tasks." });
        return;
      }

      const targetLane =
        parentTask?.laneId
          ? project.laneSummaries.find((lane) => lane.id === parentTask.laneId) ?? null
          : project.laneSummaries.find((lane) => lane.id === body?.laneId) ?? project.laneSummaries[0] ?? null;
      if (!targetLane) {
        await fulfillJson(route, 404, { message: "Project or lane not found." });
        return;
      }

      const parentTaskId = parentTask?.id ?? null;

      const createdTask: Task = {
        body: body?.body ?? "",
        createdAt: "2026-03-18T08:00:00.000Z",
        id: `task-${nextTaskId++}`,
        laneId: targetLane.id,
        parentTaskId,
        position: listSiblingTasks(projectId, targetLane.id, parentTaskId).length,
        projectId,
        ticketId: allocateNextTicketId(projectId),
        tags: body?.tags ?? [],
        title: body?.title ?? "Untitled task",
        updatedAt: "2026-03-18T08:00:00.000Z"
      };
      taskState.push(createdTask);
      syncReusableTagColors(createdTask.tags);
      syncProject(projectId);
      await fulfillJson(route, 201, createdTask);
      return;
    }

    if (request.method() === "DELETE" && url.pathname.startsWith("/api/v1/projects/") && !url.pathname.includes("/tasks/")) {
      const projectId = url.pathname.split("/").pop() ?? "";
      const projectIndex = projectState.findIndex((candidate) => candidate.id === projectId);

      if (projectIndex === -1) {
        await fulfillJson(route, 404, { message: `Project not found: ${projectId}` });
        return;
      }

      projectState.splice(projectIndex, 1);
      projectTicketPrefixes.delete(projectId);
      nextTicketNumbers.delete(projectId);
      for (let index = taskState.length - 1; index >= 0; index -= 1) {
        if (taskState[index].projectId === projectId) {
          taskState.splice(index, 1);
        }
      }
      if (deleteProjectDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, deleteProjectDelayMs));
      }
      await fulfillJson(route, 204, null);
      return;
    }

    if (request.method() === "DELETE" && url.pathname.startsWith("/api/v1/projects/") && url.pathname.includes("/tasks/")) {
      const [projectId, taskId] = [url.pathname.split("/")[4], url.pathname.split("/").pop() ?? ""];
      const taskIndex = taskState.findIndex(
        (candidate) => candidate.projectId === projectId && candidate.id === taskId
      );

      if (taskIndex === -1) {
        await fulfillJson(route, 404, { message: `Task not found: ${taskId}` });
        return;
      }

      const [removedTask] = taskState.splice(taskIndex, 1);
      if (!removedTask.laneId) {
        syncProject(projectId);
        await fulfillJson(route, 204, null);
        return;
      }

        const childTasks = listChildTasks(projectId, removedTask.id);
      if (removedTask.parentTaskId !== null) {
        reindexTaskGroup(projectId, removedTask.laneId, removedTask.parentTaskId);
      } else if (childTasks.length > 0) {
        const topLevelTasks = listSiblingTasks(projectId, removedTask.laneId, null);
        childTasks.forEach((childTask) => {
          childTask.parentTaskId = null;
          childTask.updatedAt = "2026-03-18T08:05:00.000Z";
        });

        const insertIndex = Math.max(0, Math.min(removedTask.position, topLevelTasks.length));
        topLevelTasks.splice(insertIndex, 0, ...childTasks);
        topLevelTasks.forEach((task, index) => {
          task.position = index;
        });
      } else {
        reindexTaskGroup(projectId, removedTask.laneId, null);
      }
      syncProject(projectId);
      await fulfillJson(route, 204, null);
      return;
    }

    if (request.method() === "PATCH" && url.pathname.startsWith("/api/v1/projects/") && url.pathname.includes("/tasks/")) {
      const [projectId, taskId] = [url.pathname.split("/")[4], url.pathname.split("/").pop() ?? ""];
      const task = taskState.find((candidate) => candidate.projectId === projectId && candidate.id === taskId);
      const project = getProject(projectId);

      if (!task || !project) {
        await fulfillJson(route, 404, { message: "Task or lane not found." });
        return;
      }

      const remainingFailures = taskPatchFailuresById.get(taskId) ?? 0;
      if (remainingFailures > 0) {
        taskPatchFailuresById.set(taskId, remainingFailures - 1);
        await fulfillJson(route, 500, { message: "Task save failed." });
        return;
      }

      if (
        typeof body?.destinationProjectId === "string" &&
        body.destinationProjectId.length > 0 &&
        body.destinationProjectId !== projectId
      ) {
        const movedTask = moveTaskToProject(task, body.destinationProjectId);
        if (movedTask.status === "destination_project_not_found") {
          await fulfillJson(route, 404, { message: "Destination project not found." });
          return;
        }

        if (movedTask.status === "lane_not_found") {
          await fulfillJson(route, 404, { message: "Task or lane not found." });
          return;
        }

        task.body = body?.body ?? task.body;
        if (body?.tags !== undefined) {
          task.tags = body.tags;
          syncReusableTagColors(task.tags);
        }
        task.title = body?.title ?? task.title;
        task.updatedAt = "2026-03-18T08:05:00.000Z";

        if (taskMoveDelayMs > 0) {
          await new Promise((resolve) => {
            setTimeout(resolve, taskMoveDelayMs);
          });
        }

        await fulfillJson(route, 200, task);
        return;
      }

      const nextParentTaskId =
        body?.parentTaskId === undefined && task.parentTaskId !== null && body?.laneId !== undefined
          ? null
          : body?.parentTaskId === undefined
            ? task.parentTaskId
            : body.parentTaskId;
      const parentTask =
        nextParentTaskId === null
          ? null
          : taskState.find(
              (candidate) => candidate.projectId === projectId && candidate.id === nextParentTaskId
            ) ?? null;

      if (nextParentTaskId !== null && !parentTask) {
        await fulfillJson(route, 404, { message: "Parent task not found." });
        return;
      }

      if (
        (parentTask && (parentTask.parentTaskId !== null || parentTask.id === task.id)) ||
        (nextParentTaskId !== null && taskHasChildren(projectId, task.id))
      ) {
        await fulfillJson(route, 400, { message: "Subtasks can only be added under top-level tasks." });
        return;
      }

      const nextLane =
        parentTask?.laneId
          ? project.laneSummaries.find((lane) => lane.id === parentTask.laneId) ?? null
          : (body?.laneId ? project.laneSummaries.find((lane) => lane.id === body.laneId) : undefined) ??
            project.laneSummaries.find((lane) => lane.id === task.laneId) ??
            null;
      if (!nextLane) {
        await fulfillJson(route, 404, { message: "Task or lane not found." });
        return;
      }

      const isTaskMoveRequest =
        body?.laneId !== undefined || body?.parentTaskId !== undefined || body?.position !== undefined;

      if (isTaskMoveRequest) {
        moveTask(
          task,
          nextLane.id,
          parentTask?.id ?? null,
          body?.position ?? listSiblingTasks(projectId, nextLane.id, parentTask?.id ?? null).length
        );
      }

      task.body = body?.body ?? task.body;
      if (body?.tags !== undefined) {
        task.tags = body.tags;
        syncReusableTagColors(task.tags);
      }
      task.title = body?.title ?? task.title;
      task.updatedAt = "2026-03-18T08:05:00.000Z";
      syncProject(projectId);

      const taskPatchResponseDelayMs = isTaskMoveRequest ? taskMoveDelayMs : taskPatchDelayMs;
      if (taskPatchResponseDelayMs > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, taskPatchResponseDelayMs);
        });
      }

      await fulfillJson(route, 200, task);
      return;
    }

    await fulfillJson(route, 404, { message: `Unhandled route: ${key}` });
  });
}
