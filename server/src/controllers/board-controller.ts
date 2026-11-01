import { z } from "zod";

import {
  createLaneBodySchema,
  createProjectBodySchema,
  createTaskBodySchema,
  deleteLaneBodySchema,
  errorResponseSchema,
  laneParamsSchema,
  laneResponseSchema,
  listProjectsQuerySchema,
  projectParamsSchema,
  projectTicketPrefixParamsSchema,
  projectResponseSchema,
  taskParamsSchema,
  taskResponseSchema,
  taskTagsResponseSchema,
  ticketIdParamsSchema,
  todoProjectGroupsResponseSchema,
  toLaneResponse,
  toProjectResponse,
  toTodoProjectGroupResponse,
  toTaskResponse,
  updateLaneBodySchema,
  updateProjectBodySchema,
  updateTaskBodySchema
} from "../api-schemas.js";
import {
  createLane,
  createProject,
  createTask,
  deleteOwnedLane,
  deleteOwnedProject,
  deleteOwnedTask,
  getOwnedProject,
  getOwnedProjectByTicketPrefix,
  getOwnedTaskByTicketId,
  listLanesForProject,
  listProjectsForUser,
  listTodoProjectGroupsForUser,
  listTaskTagsForUser,
  listTasksForProject,
  updateOwnedLane,
  updateOwnedProject,
  updateOwnedTask,
  type DatabaseClient
} from "../db.js";
import { apiDocsSecurity, requireApiUser, type TypedApp } from "./controller-support.js";

export function registerBoardController(
  app: TypedApp,
  options: {
    database: DatabaseClient;
  }
) {
  const { database } = options;

  app.route({
    method: "GET",
    url: "/api/v1/task-tags",
    schema: {
      security: apiDocsSecurity,
      response: {
        200: taskTagsResponseSchema,
        401: errorResponseSchema
      },
      tags: ["tags"]
    },
    handler: async (request, reply) => {
      const user = await requireApiUser(app, database, request, reply);
      if (!user) {
        return;
      }

      return taskTagsResponseSchema.parse(listTaskTagsForUser(database, user.id));
    }
  });

  app.route({
    method: "GET",
    url: "/api/v1/todos",
    schema: {
      security: apiDocsSecurity,
      response: {
        200: todoProjectGroupsResponseSchema,
        401: errorResponseSchema
      },
      tags: ["tasks"]
    },
    handler: async (request, reply) => {
      const user = await requireApiUser(app, database, request, reply);
      if (!user) {
        return;
      }

      return todoProjectGroupsResponseSchema.parse(
        listTodoProjectGroupsForUser(database, user.id).map((group) => toTodoProjectGroupResponse(group))
      );
    }
  });

  app.route({
    method: "GET",
    url: "/api/v1/projects",
    schema: {
      querystring: listProjectsQuerySchema,
      security: apiDocsSecurity,
      response: {
        200: z.array(projectResponseSchema),
        400: errorResponseSchema,
        401: errorResponseSchema
      },
      tags: ["projects"]
    },
    handler: async (request, reply) => {
      const user = await requireApiUser(app, database, request, reply);
      if (!user) {
        return;
      }

      return listProjectsForUser(database, user.id, request.query).map((project) =>
        toProjectResponse(project, project.laneSummaries)
      );
    }
  });

  app.route({
    method: "GET",
    url: "/api/v1/projects/by-ticket-prefix/:ticketPrefix",
    schema: {
      params: projectTicketPrefixParamsSchema,
      security: apiDocsSecurity,
      response: {
        200: projectResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        404: errorResponseSchema
      },
      tags: ["projects"]
    },
    handler: async (request, reply) => {
      const user = await requireApiUser(app, database, request, reply);
      if (!user) {
        return;
      }

      const project = getOwnedProjectByTicketPrefix(database, {
        ticketPrefix: request.params.ticketPrefix,
        userId: user.id
      });
      if (!project) {
        return reply.status(404).send({
          message: "Project not found."
        });
      }

      const laneSummaries = listLanesForProject(database, {
        userId: user.id,
        projectId: project.id
      });

      return toProjectResponse(project, laneSummaries ?? []);
    }
  });

  app.route({
    method: "POST",
    url: "/api/v1/projects",
    schema: {
      body: createProjectBodySchema,
      security: apiDocsSecurity,
      response: {
        201: projectResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema
      },
      tags: ["projects"]
    },
    handler: async (request, reply) => {
      const user = await requireApiUser(app, database, request, reply);
      if (!user) {
        return;
      }

      const project = createProject(database, user.id, request.body.name.trim());
      const laneSummaries = listLanesForProject(database, {
        userId: user.id,
        projectId: project.id
      });

      return reply.status(201).send(toProjectResponse(project, laneSummaries ?? []));
    }
  });

  app.route({
    method: "PATCH",
    url: "/api/v1/projects/:projectId",
    schema: {
      body: updateProjectBodySchema,
      params: projectParamsSchema,
      security: apiDocsSecurity,
      response: {
        200: projectResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        404: errorResponseSchema
      },
      tags: ["projects"]
    },
    handler: async (request, reply) => {
      const user = await requireApiUser(app, database, request, reply);
      if (!user) {
        return;
      }

      const project = updateOwnedProject(database, {
        ...request.body,
        projectId: request.params.projectId,
        userId: user.id
      });
      if (!project) {
        return reply.status(404).send({
          message: "Project not found."
        });
      }

      const laneSummaries = listLanesForProject(database, {
        userId: user.id,
        projectId: project.id
      });

      return toProjectResponse(project, laneSummaries ?? []);
    }
  });

  app.route({
    method: "DELETE",
    url: "/api/v1/projects/:projectId",
    schema: {
      params: projectParamsSchema,
      security: apiDocsSecurity,
      response: {
        204: z.null(),
        401: errorResponseSchema,
        404: errorResponseSchema
      },
      tags: ["projects"]
    },
    handler: async (request, reply) => {
      const user = await requireApiUser(app, database, request, reply);
      if (!user) {
        return;
      }

      const deleted = deleteOwnedProject(database, user.id, request.params.projectId);
      if (!deleted) {
        return reply.status(404).send({
          message: "Project not found."
        });
      }

      return reply.status(204).send(null);
    }
  });

  app.route({
    method: "GET",
    url: "/api/v1/projects/:projectId/lanes",
    schema: {
      params: projectParamsSchema,
      security: apiDocsSecurity,
      response: {
        200: z.array(laneResponseSchema),
        401: errorResponseSchema,
        404: errorResponseSchema
      },
      tags: ["lanes"]
    },
    handler: async (request, reply) => {
      const user = await requireApiUser(app, database, request, reply);
      if (!user) {
        return;
      }

      const projectLanes = listLanesForProject(database, {
        userId: user.id,
        projectId: request.params.projectId
      });
      if (!projectLanes) {
        return reply.status(404).send({
          message: "Project not found."
        });
      }

      return projectLanes.map(toLaneResponse);
    }
  });

  app.route({
    method: "POST",
    url: "/api/v1/projects/:projectId/lanes",
    schema: {
      body: createLaneBodySchema,
      params: projectParamsSchema,
      security: apiDocsSecurity,
      response: {
        201: laneResponseSchema,
        401: errorResponseSchema,
        404: errorResponseSchema
      },
      tags: ["lanes"]
    },
    handler: async (request, reply) => {
      const user = await requireApiUser(app, database, request, reply);
      if (!user) {
        return;
      }

      const lane = createLane(database, {
        userId: user.id,
        projectId: request.params.projectId,
        name: request.body.name.trim()
      });
      if (!lane) {
        return reply.status(404).send({
          message: "Project not found."
        });
      }

      return reply.status(201).send(toLaneResponse(lane));
    }
  });

  app.route({
    method: "PATCH",
    url: "/api/v1/projects/:projectId/lanes/:laneId",
    schema: {
      body: updateLaneBodySchema,
      params: laneParamsSchema,
      security: apiDocsSecurity,
      response: {
        200: laneResponseSchema,
        401: errorResponseSchema,
        404: errorResponseSchema
      },
      tags: ["lanes"]
    },
    handler: async (request, reply) => {
      const user = await requireApiUser(app, database, request, reply);
      if (!user) {
        return;
      }

      const lane = updateOwnedLane(database, {
        userId: user.id,
        projectId: request.params.projectId,
        laneId: request.params.laneId,
        position: request.body.position
      });
      if (!lane) {
        return reply.status(404).send({
          message: "Lane not found."
        });
      }

      const projectLanes = listLanesForProject(database, {
        userId: user.id,
        projectId: request.params.projectId
      });
      const updatedLane = projectLanes?.find((candidate) => candidate.id === lane.id);

      return toLaneResponse(updatedLane ?? lane);
    }
  });

  app.route({
    method: "DELETE",
    url: "/api/v1/projects/:projectId/lanes/:laneId",
    schema: {
      body: deleteLaneBodySchema.nullish(),
      params: laneParamsSchema,
      security: apiDocsSecurity,
      response: {
        204: z.null(),
        400: errorResponseSchema,
        401: errorResponseSchema,
        404: errorResponseSchema
      },
      tags: ["lanes"]
    },
    handler: async (request, reply) => {
      const user = await requireApiUser(app, database, request, reply);
      if (!user) {
        return;
      }

      const deleted = deleteOwnedLane(database, {
        userId: user.id,
        projectId: request.params.projectId,
        laneId: request.params.laneId,
        destinationLaneId: request.body?.destinationLaneId
      });

      if (deleted.status === "project_not_found" || deleted.status === "lane_not_found") {
        return reply.status(404).send({
          message: deleted.status === "project_not_found" ? "Project not found." : "Lane not found."
        });
      }

      if (deleted.status === "last_lane") {
        return reply.status(400).send({
          message: "Projects must keep at least one lane."
        });
      }

      if (deleted.status === "protected_lane") {
        return reply.status(400).send({
          message: "Todo and Done lanes cannot be deleted."
        });
      }

      if (deleted.status === "destination_required") {
        return reply.status(400).send({
          message: "Select a destination lane before deleting this lane."
        });
      }

      if (deleted.status === "destination_not_found") {
        return reply.status(400).send({
          message: "Destination lane not found."
        });
      }

      return reply.status(204).send(null);
    }
  });

  app.route({
    method: "GET",
    url: "/api/v1/tasks/by-ticket/:ticketId",
    schema: {
      params: ticketIdParamsSchema,
      security: apiDocsSecurity,
      response: {
        200: taskResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        404: errorResponseSchema
      },
      tags: ["tasks"]
    },
    handler: async (request, reply) => {
      const user = await requireApiUser(app, database, request, reply);
      if (!user) {
        return;
      }

      const task = getOwnedTaskByTicketId(database, {
        userId: user.id,
        ticketId: request.params.ticketId
      });
      if (!task) {
        return reply.status(404).send({
          message: "Task not found."
        });
      }

      return toTaskResponse(task.task, { ticketPrefix: task.ticketPrefix });
    }
  });

  app.route({
    method: "GET",
    url: "/api/v1/projects/:projectId/tasks",
    schema: {
      params: projectParamsSchema,
      security: apiDocsSecurity,
      response: {
        200: z.array(taskResponseSchema),
        401: errorResponseSchema,
        404: errorResponseSchema
      },
      tags: ["tasks"]
    },
    handler: async (request, reply) => {
      const user = await requireApiUser(app, database, request, reply);
      if (!user) {
        return;
      }

      const project = getOwnedProject(database, user.id, request.params.projectId);
      if (!project) {
        return reply.status(404).send({
          message: "Project not found."
        });
      }

      const tasks = listTasksForProject(database, {
        userId: user.id,
        projectId: request.params.projectId
      });
      if (!tasks) {
        return reply.status(404).send({
          message: "Project not found."
        });
      }

      return tasks.map((task) => toTaskResponse(task, { ticketPrefix: project.ticketPrefix as string }));
    }
  });

  app.route({
    method: "POST",
    url: "/api/v1/projects/:projectId/tasks",
    schema: {
      body: createTaskBodySchema,
      params: projectParamsSchema,
      security: apiDocsSecurity,
      response: {
        400: errorResponseSchema,
        201: taskResponseSchema,
        401: errorResponseSchema,
        404: errorResponseSchema
      },
      tags: ["tasks"]
    },
    handler: async (request, reply) => {
      const user = await requireApiUser(app, database, request, reply);
      if (!user) {
        return;
      }

      const task = createTask(database, {
        userId: user.id,
        projectId: request.params.projectId,
        title: request.body.title.trim(),
        body: request.body.body,
        laneId: request.body.laneId,
        parentTaskId: request.body.parentTaskId,
        tags: request.body.tags
      });
      if (
        task.status === "project_not_found" ||
        task.status === "lane_not_found" ||
        task.status === "parent_not_found"
      ) {
        return reply.status(404).send({
          message:
            task.status === "project_not_found" || task.status === "lane_not_found"
              ? "Project or lane not found."
              : "Parent task not found."
        });
      }

      if (task.status === "invalid_parent") {
        return reply.status(400).send({
          message: "Subtasks can only be added under top-level tasks."
        });
      }

      if (task.status !== "created") {
        throw new Error(`Unexpected create task status: ${task.status}`);
      }

      const project = getOwnedProject(database, user.id, request.params.projectId);
      if (!project) {
        return reply.status(404).send({
          message: "Project or lane not found."
        });
      }

      return reply.status(201).send(toTaskResponse(task.task, { ticketPrefix: project.ticketPrefix as string }));
    }
  });

  app.route({
    method: "PATCH",
    url: "/api/v1/projects/:projectId/tasks/:taskId",
    schema: {
      body: updateTaskBodySchema,
      params: taskParamsSchema,
      security: apiDocsSecurity,
      response: {
        400: errorResponseSchema,
        200: taskResponseSchema,
        401: errorResponseSchema,
        404: errorResponseSchema
      },
      tags: ["tasks"]
    },
    handler: async (request, reply) => {
      const user = await requireApiUser(app, database, request, reply);
      if (!user) {
        return;
      }

      const task = updateOwnedTask(database, {
        userId: user.id,
        projectId: request.params.projectId,
        taskId: request.params.taskId,
        title: request.body.title?.trim(),
        body: request.body.body,
        destinationProjectId: request.body.destinationProjectId,
        laneId: request.body.laneId,
        parentTaskId: request.body.parentTaskId,
        tags: request.body.tags,
        position: request.body.position
      });
      if (
        task.status === "task_not_found" ||
        task.status === "destination_project_not_found" ||
        task.status === "lane_not_found" ||
        task.status === "parent_not_found"
      ) {
        return reply.status(404).send({
          message:
            task.status === "parent_not_found"
              ? "Parent task not found."
              : task.status === "destination_project_not_found"
                ? "Destination project not found."
                : "Task or lane not found."
        });
      }

      if (task.status === "invalid_parent") {
        return reply.status(400).send({
          message: "Subtasks can only be added under top-level tasks."
        });
      }

      if (task.status !== "updated") {
        throw new Error(`Unexpected update task status: ${task.status}`);
      }

      const project = getOwnedProject(database, user.id, task.task.projectId);
      if (!project) {
        return reply.status(404).send({
          message: "Task or lane not found."
        });
      }

      return toTaskResponse(task.task, { ticketPrefix: project.ticketPrefix as string });
    }
  });

  app.route({
    method: "DELETE",
    url: "/api/v1/projects/:projectId/tasks/:taskId",
    schema: {
      params: taskParamsSchema,
      security: apiDocsSecurity,
      response: {
        204: z.null(),
        401: errorResponseSchema,
        404: errorResponseSchema
      },
      tags: ["tasks"]
    },
    handler: async (request, reply) => {
      const user = await requireApiUser(app, database, request, reply);
      if (!user) {
        return;
      }

      const deleted = deleteOwnedTask(database, {
        userId: user.id,
        projectId: request.params.projectId,
        taskId: request.params.taskId
      });
      if (!deleted) {
        return reply.status(404).send({
          message: "Task not found."
        });
      }

      return reply.status(204).send(null);
    }
  });
}
