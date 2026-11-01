import { z } from "zod";

import type {
  LaneRecord,
  LaneWithTaskCount,
  ProjectRecord,
  TaskTagColor,
  TaskTagData,
  TaskRecord,
  TaskRecordWithTags,
  UserTheme,
  UserRecord
} from "./db.js";
import { taskTagColorValues, userThemeValues } from "./db.js";

export const userThemeSchema = z.enum(userThemeValues);
export const taskTagColorSchema = z.enum(taskTagColorValues);
export const taskTagLabelSchema = z.string().trim().min(1).max(32);
export const taskTagSchema = z.object({
  color: taskTagColorSchema,
  label: taskTagLabelSchema
});
export const taskTagInputSchema = z.union([taskTagLabelSchema, taskTagSchema]);
export const taskTagsInputSchema = z.array(taskTagInputSchema).max(12);
export const taskTagsResponseSchema = z.array(taskTagSchema);

export const errorResponseSchema = z.object({
  message: z.string()
});

export const meResponseSchema = z.object({
  email: z.string().nullable(),
  id: z.string(),
  name: z.string().nullable(),
  theme: userThemeSchema
});

export const updateThemeBodySchema = z.object({
  theme: userThemeSchema
});

export const laneResponseSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  position: z.number().int().nonnegative(),
  taskCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const projectTicketPrefixSchema = z
  .string()
  .regex(/^[A-Z]{2,4}$/, "Invalid project ticket prefix.");

export const projectResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  archived: z.boolean(),
  ticketPrefix: projectTicketPrefixSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  laneSummaries: z.array(laneResponseSchema)
});

export const taskResponseSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  laneId: z.string().nullable(),
  parentTaskId: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  ticketId: z.string(),
  tags: taskTagsResponseSchema,
  position: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const todoProjectGroupResponseSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  projectTicketPrefix: projectTicketPrefixSchema,
  tasks: z.array(taskResponseSchema)
});
export const todoProjectGroupsResponseSchema = z.array(todoProjectGroupResponseSchema);

export const apiTokenSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable()
});

export const createApiTokenResponseSchema = z.object({
  token: z.string(),
  tokenInfo: apiTokenSummarySchema
});

export const createProjectBodySchema = z.object({
  name: z.string().trim().min(1).max(120)
});

export const listProjectsQuerySchema = z.object({
  includeArchived: z.enum(["true", "false"]).default("false").transform((value) => value === "true")
});

export const updateProjectBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    archived: z.boolean().optional()
  })
  .refine((input) => input.name !== undefined || input.archived !== undefined, {
    message: "Provide a project name or archive status."
  });

export const createLaneBodySchema = z.object({
  name: z.string().trim().min(1).max(80)
});

export const deleteLaneBodySchema = z.object({
  destinationLaneId: z.string().uuid().optional()
});

export const updateLaneBodySchema = z.object({
  position: z.number().int().nonnegative()
});

export const createApiTokenBodySchema = z.object({
  name: z.string().trim().min(1).max(120)
});

export const projectParamsSchema = z.object({
  projectId: z.string().uuid()
});

export const projectTicketPrefixParamsSchema = z.object({
  ticketPrefix: projectTicketPrefixSchema
});

export const laneParamsSchema = z.object({
  projectId: z.string().uuid(),
  laneId: z.string().uuid()
});

export const apiTokenParamsSchema = z.object({
  tokenId: z.string().uuid()
});

export const createTaskBodySchema = z.object({
  title: z.string().trim().min(1).max(240),
  body: z.string().max(40_000).optional(),
  laneId: z.string().uuid().optional(),
  parentTaskId: z.string().uuid().optional(),
  tags: taskTagsInputSchema.optional()
});

export const taskParamsSchema = z.object({
  projectId: z.string().uuid(),
  taskId: z.string().uuid()
});

export const ticketIdParamsSchema = z.object({
  ticketId: z.string().regex(/^[A-Z]{2,4}-[1-9]\d*$/, "Invalid ticket ID.")
});

export const updateTaskBodySchema = z
  .object({
    title: z.string().trim().min(1).max(240).optional(),
    body: z.string().max(40_000).optional(),
    laneId: z.string().uuid().optional(),
    destinationProjectId: z.string().uuid().optional(),
    parentTaskId: z.string().uuid().nullable().optional(),
    tags: taskTagsInputSchema.optional(),
    position: z.number().int().nonnegative().optional()
  })
  .refine(
    (value) =>
      value.title !== undefined ||
      value.body !== undefined ||
      value.laneId !== undefined ||
      value.destinationProjectId !== undefined ||
      value.parentTaskId !== undefined ||
      value.tags !== undefined ||
      value.position !== undefined,
    {
      message: "Provide at least one field to update."
    }
  );

z.globalRegistry.add(meResponseSchema, { id: "Me" });
z.globalRegistry.add(laneResponseSchema, { id: "Lane" });
z.globalRegistry.add(projectResponseSchema, { id: "Project" });
z.globalRegistry.add(taskResponseSchema, { id: "Task" });
z.globalRegistry.add(todoProjectGroupResponseSchema, { id: "TodoProjectGroup" });
z.globalRegistry.add(taskTagSchema, { id: "TaskTag" });
z.globalRegistry.add(apiTokenSummarySchema, { id: "ApiTokenSummary" });
z.globalRegistry.add(errorResponseSchema, { id: "ErrorResponse" });

export function toMeResponse(user: UserRecord) {
  return meResponseSchema.parse({
    email: user.email ?? null,
    id: user.id,
    name: user.displayName ?? null,
    theme: user.theme satisfies UserTheme
  });
}

export function toLaneResponse(lane: LaneRecord | LaneWithTaskCount, taskCount = 0) {
  return laneResponseSchema.parse({
    id: lane.id,
    projectId: lane.projectId,
    name: lane.name,
    position: lane.position,
    taskCount: "taskCount" in lane ? lane.taskCount : taskCount,
    createdAt: lane.createdAt,
    updatedAt: lane.updatedAt
  });
}

export function toProjectResponse(
  project: ProjectRecord,
  laneSummaries: Array<LaneRecord | LaneWithTaskCount> = []
) {
  return projectResponseSchema.parse({
    id: project.id,
    name: project.name,
    archived: project.archived,
    ticketPrefix: project.ticketPrefix,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    laneSummaries: laneSummaries.map((lane) => toLaneResponse(lane))
  });
}

export function toTaskResponse(
  task: TaskRecord | TaskRecordWithTags,
  options: {
    ticketPrefix: string;
  }
) {
  return taskResponseSchema.parse({
    id: task.id,
    projectId: task.projectId,
    laneId: task.laneId ?? null,
    parentTaskId: task.parentTaskId ?? null,
    title: task.title,
    body: task.body,
    ticketId: `${options.ticketPrefix}-${task.ticketNumber}`,
    tags:
      "tags" in task
        ? task.tags
        : ([] satisfies TaskTagData[]),
    position: task.position,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  });
}

export function toTodoProjectGroupResponse(group: {
  projectId: string;
  projectName: string;
  projectTicketPrefix: string;
  tasks: TaskRecordWithTags[];
}) {
  return todoProjectGroupResponseSchema.parse({
    projectId: group.projectId,
    projectName: group.projectName,
    projectTicketPrefix: group.projectTicketPrefix,
    tasks: group.tasks.map((task) =>
      toTaskResponse(task, {
        ticketPrefix: group.projectTicketPrefix
      })
    )
  });
}

export function toApiTokenSummary(
  token: {
    id: string;
    name: string;
    createdAt: string;
    lastUsedAt: string | null;
  }
) {
  return apiTokenSummarySchema.parse({
    id: token.id,
    name: token.name,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt ?? null
  });
}
