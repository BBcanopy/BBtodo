import type Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { type AnySQLiteColumn, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
};

export const userThemeValues = ["sea", "ember", "midnight"] as const;
export type UserTheme = (typeof userThemeValues)[number];
export const taskTagColorValues = ["moss", "sky", "amber", "coral", "orchid", "slate"] as const;
export type TaskTagColor = (typeof taskTagColorValues)[number];
export const defaultTaskTagColor: TaskTagColor = "moss";

export const defaultLaneTemplates = ["Todo", "In Progress", "In review", "Done"] as const;
export const legacyDefaultLaneTemplates = ["Todo", "In Progress", "Done"] as const;

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    email: text("email"),
    displayName: text("display_name"),
    theme: text("theme", { enum: userThemeValues }).notNull().default("sea"),
    ...timestamps
  },
  (table) => [uniqueIndex("users_issuer_subject_idx").on(table.issuer, table.subject)]
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: text("expires_at").notNull(),
    oidcToken: text("oidc_token"),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt)
  ]
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    ticketPrefix: text("ticket_prefix"),
    nextTicketNumber: integer("next_ticket_number"),
    ...timestamps
  },
  (table) => [
    index("projects_user_updated_at_idx").on(table.userId, table.updatedAt),
    uniqueIndex("projects_user_ticket_prefix_idx").on(table.userId, table.ticketPrefix)
  ]
);

export const lanes = sqliteTable(
  "lanes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    ...timestamps
  },
  (table) => [index("lanes_project_position_idx").on(table.projectId, table.position)]
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    laneId: text("lane_id").references(() => lanes.id, { onDelete: "cascade" }),
    parentTaskId: text("parent_task_id").references((): AnySQLiteColumn => tasks.id, {
      onDelete: "set null"
    }),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    ticketNumber: integer("ticket_number"),
    position: integer("position").notNull().default(0),
    ...timestamps
  },
  (table) => [
    index("tasks_project_lane_parent_position_idx").on(
      table.projectId,
      table.laneId,
      table.parentTaskId,
      table.position
    ),
    uniqueIndex("tasks_project_ticket_number_idx").on(table.projectId, table.ticketNumber)
  ]
);

export const taskTags = sqliteTable(
  "task_tags",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    color: text("color", { enum: taskTagColorValues }).notNull().default(defaultTaskTagColor),
    position: integer("position").notNull()
  },
  (table) => [
    index("task_tags_task_position_idx").on(table.taskId, table.position),
    uniqueIndex("task_tags_task_tag_idx").on(table.taskId, table.tag)
  ]
);

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    salt: text("salt").notNull(),
    tokenHash: text("token_hash").notNull(),
    lastUsedAt: text("last_used_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [index("api_tokens_user_updated_at_idx").on(table.userId, table.updatedAt)]
);

export type DatabaseClient = BetterSQLite3Database<{
  apiTokens: typeof apiTokens;
  lanes: typeof lanes;
  projects: typeof projects;
  sessions: typeof sessions;
  taskTags: typeof taskTags;
  tasks: typeof tasks;
  users: typeof users;
}>;

export type UserRecord = typeof users.$inferSelect;
export type SessionRecord = typeof sessions.$inferSelect;
export type ProjectRecord = typeof projects.$inferSelect;
export type LaneRecord = typeof lanes.$inferSelect;
export type TaskRecord = typeof tasks.$inferSelect;
export type TaskTagRecord = typeof taskTags.$inferSelect;
export type ApiTokenRecord = typeof apiTokens.$inferSelect;

export interface TaskTagData {
  color: TaskTagColor;
  label: string;
}

export type TaskTagInput = string | TaskTagData;

export interface TaskRecordWithTags extends TaskRecord {
  tags: TaskTagData[];
}

export interface LaneWithTaskCount extends LaneRecord {
  taskCount: number;
}

export interface ProjectWithLanes extends ProjectRecord {
  laneSummaries: LaneWithTaskCount[];
}

export interface DatabaseServices {
  database: Database.Database;
  db: DatabaseClient;
}
