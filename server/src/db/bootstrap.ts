import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { backfillTicketIds } from "./board.js";
import {
  apiTokens,
  type DatabaseClient,
  type DatabaseServices,
  legacyDefaultLaneTemplates,
  lanes,
  projects,
  sessions,
  tasks,
  taskTags,
  users
} from "./schema.js";

export const SQLITE_DATABASE_PATH = "/data/bbtodo.sqlite";
const DRIZZLE_MIGRATIONS_TABLE = "__drizzle_migrations";
const DRIZZLE_MIGRATIONS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

interface MigrationJournalEntry {
  breakpoints: boolean;
  idx: number;
  tag: string;
  version: string;
  when: number;
}

function getLatestMigrationEntry() {
  const journalPath = resolve(DRIZZLE_MIGRATIONS_PATH, "meta", "_journal.json");
  if (!existsSync(journalPath)) {
    throw new Error(`Missing Drizzle migration journal at ${journalPath}.`);
  }

  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries?: MigrationJournalEntry[];
  };
  const latestEntry = journal.entries?.at(-1);
  if (!latestEntry) {
    throw new Error("Drizzle migration journal is empty.");
  }

  const sqlPath = resolve(DRIZZLE_MIGRATIONS_PATH, `${latestEntry.tag}.sql`);
  const sql = readFileSync(sqlPath, "utf8");

  return {
    createdAt: latestEntry.when,
    hash: createHash("sha256").update(sql).digest("hex")
  };
}

function tableExists(database: Database.Database, tableName: string) {
  const result = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName);

  return result !== undefined;
}

function getTableColumns(database: Database.Database, tableName: string) {
  if (!tableExists(database, tableName)) {
    return new Set<string>();
  }

  return new Set(
    database
      .prepare(`PRAGMA table_info(${tableName})`)
      .all()
      .map((column) => String((column as { name: string }).name))
  );
}

function hasAnyApplicationTables(database: Database.Database) {
  return ["api_tokens", "lanes", "projects", "sessions", "task_tags", "tasks", "users"].some(
    (tableName) => tableExists(database, tableName)
  );
}

function createLegacyCompatTables(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      email TEXT,
      display_name TEXT,
      theme TEXT NOT NULL DEFAULT 'sea',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      oidc_token TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      ticket_prefix TEXT,
      next_ticket_number INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lanes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      system_key TEXT,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      lane_id TEXT REFERENCES lanes(id) ON DELETE CASCADE,
      parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      ticket_number INTEGER,
      position INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_tags (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT 'moss',
      position INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      salt TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function ensureLegacyCompatColumns(database: Database.Database) {
  const userColumns = getTableColumns(database, "users");
  if (!userColumns.has("theme")) {
    database.exec("ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'sea';");
  }

  const sessionColumns = getTableColumns(database, "sessions");
  if (!sessionColumns.has("oidc_token")) {
    database.exec("ALTER TABLE sessions ADD COLUMN oidc_token TEXT;");
  }

  const taskColumns = getTableColumns(database, "tasks");
  if (!taskColumns.has("body")) {
    database.exec("ALTER TABLE tasks ADD COLUMN body TEXT NOT NULL DEFAULT '';");
  }
  if (!taskColumns.has("ticket_number")) {
    database.exec("ALTER TABLE tasks ADD COLUMN ticket_number INTEGER;");
  }
  if (!taskColumns.has("lane_id")) {
    database.exec(
      "ALTER TABLE tasks ADD COLUMN lane_id TEXT REFERENCES lanes(id) ON DELETE CASCADE;"
    );
  }
  if (!taskColumns.has("position")) {
    database.exec("ALTER TABLE tasks ADD COLUMN position INTEGER NOT NULL DEFAULT 0;");
  }
  if (!taskColumns.has("parent_task_id")) {
    database.exec(
      "ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;"
    );
  }

  const taskTagColumns = getTableColumns(database, "task_tags");
  if (!taskTagColumns.has("color")) {
    database.exec("ALTER TABLE task_tags ADD COLUMN color TEXT NOT NULL DEFAULT 'moss';");
  }

  const projectColumns = getTableColumns(database, "projects");
  if (!projectColumns.has("archived")) {
    database.exec("ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;");
  }
  if (!projectColumns.has("ticket_prefix")) {
    database.exec("ALTER TABLE projects ADD COLUMN ticket_prefix TEXT;");
  }
  if (!projectColumns.has("next_ticket_number")) {
    database.exec("ALTER TABLE projects ADD COLUMN next_ticket_number INTEGER;");
  }
}

function ensureLegacyCompatIndexes(database: Database.Database) {
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_issuer_subject_idx
      ON users (issuer, subject);

    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
    CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

    CREATE INDEX IF NOT EXISTS projects_user_updated_at_idx
      ON projects (user_id, updated_at);

    CREATE UNIQUE INDEX IF NOT EXISTS projects_user_ticket_prefix_idx
      ON projects (user_id, ticket_prefix);

    CREATE INDEX IF NOT EXISTS lanes_project_position_idx
      ON lanes (project_id, position);

    CREATE UNIQUE INDEX IF NOT EXISTS lanes_project_system_key_idx
      ON lanes (project_id, system_key);

    CREATE INDEX IF NOT EXISTS tasks_project_status_updated_at_idx
      ON tasks (project_id, status, updated_at);

    CREATE INDEX IF NOT EXISTS tasks_project_lane_parent_position_idx
      ON tasks (project_id, lane_id, parent_task_id, position);

    CREATE UNIQUE INDEX IF NOT EXISTS tasks_project_ticket_number_idx
      ON tasks (project_id, ticket_number);

    CREATE INDEX IF NOT EXISTS task_tags_task_position_idx
      ON task_tags (task_id, position);

    CREATE UNIQUE INDEX IF NOT EXISTS task_tags_task_tag_idx
      ON task_tags (task_id, tag);

    CREATE INDEX IF NOT EXISTS api_tokens_user_updated_at_idx
      ON api_tokens (user_id, updated_at);
  `);
}

const legacyTaskLaneTemplates = [
  { name: legacyDefaultLaneTemplates[0], status: "todo" },
  { name: legacyDefaultLaneTemplates[1], status: "in_progress" },
  { name: legacyDefaultLaneTemplates[2], status: "done" }
] as const;

function ensureLaneOnlyIndexes(database: Database.Database) {
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_issuer_subject_idx
      ON users (issuer, subject);

    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
    CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

    CREATE INDEX IF NOT EXISTS projects_user_updated_at_idx
      ON projects (user_id, updated_at);

    CREATE UNIQUE INDEX IF NOT EXISTS projects_user_ticket_prefix_idx
      ON projects (user_id, ticket_prefix);

    CREATE INDEX IF NOT EXISTS lanes_project_position_idx
      ON lanes (project_id, position);

    CREATE INDEX IF NOT EXISTS tasks_project_lane_parent_position_idx
      ON tasks (project_id, lane_id, parent_task_id, position);

    CREATE UNIQUE INDEX IF NOT EXISTS tasks_project_ticket_number_idx
      ON tasks (project_id, ticket_number);

    CREATE INDEX IF NOT EXISTS task_tags_task_position_idx
      ON task_tags (task_id, position);

    CREATE UNIQUE INDEX IF NOT EXISTS task_tags_task_tag_idx
      ON task_tags (task_id, tag);

    CREATE INDEX IF NOT EXISTS api_tokens_user_updated_at_idx
      ON api_tokens (user_id, updated_at);
  `);
}

function backfillLegacyLaneData(database: Database.Database) {
  const projectRows = database
    .prepare("SELECT id, updated_at FROM projects ORDER BY created_at ASC, id ASC")
    .all() as Array<{ id: string; updated_at: string }>;
  const selectProjectLanes = database.prepare(
    "SELECT id, system_key FROM lanes WHERE project_id = ? ORDER BY position ASC, created_at ASC"
  );
  const countLaneTasks = database.prepare(
    "SELECT COUNT(*) AS count FROM tasks WHERE project_id = ? AND lane_id = ?"
  );
  const selectLegacyTasksByStatus = database.prepare(
    "SELECT id FROM tasks WHERE project_id = ? AND lane_id IS NULL AND status = ? ORDER BY updated_at DESC"
  );
  const insertLane = database.prepare(`
    INSERT INTO lanes (id, project_id, name, system_key, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const updateTaskPosition = database.prepare(
    "UPDATE tasks SET lane_id = ?, position = ? WHERE id = ?"
  );

  projectRows.forEach((project) => {
    const existingLanes = selectProjectLanes.all(project.id) as Array<{
      id: string;
      system_key: string | null;
    }>;
    const lanesByStatus = new Map(
      existingLanes.flatMap((lane) => (lane.system_key ? [[lane.system_key, lane.id] as const] : []))
    );

    if (existingLanes.length === 0) {
      legacyTaskLaneTemplates.forEach((template, index) => {
        const laneId = crypto.randomUUID();
        insertLane.run(
          laneId,
          project.id,
          template.name,
          template.status,
          index,
          project.updated_at,
          project.updated_at
        );
        lanesByStatus.set(template.status, laneId);
      });
    }

    legacyTaskLaneTemplates.forEach((template) => {
      const laneId = lanesByStatus.get(template.status);
      if (!laneId) {
        return;
      }

      let nextPosition =
        Number(
          (
            countLaneTasks.get(project.id, laneId) as {
              count: number;
            } | undefined
          )?.count ?? 0
        ) || 0;
      const legacyTasks = selectLegacyTasksByStatus.all(project.id, template.status) as Array<{
        id: string;
      }>;

      legacyTasks.forEach((task) => {
        updateTaskPosition.run(laneId, nextPosition, task.id);
        nextPosition += 1;
      });
    });
  });
}

function rewriteLaneOnlySchema(database: Database.Database) {
  const laneColumns = getTableColumns(database, "lanes");
  const taskColumns = getTableColumns(database, "tasks");
  if (!laneColumns.has("system_key") && !taskColumns.has("status")) {
    ensureLaneOnlyIndexes(database);
    return;
  }

  const foreignKeysEnabled = database.pragma("foreign_keys", { simple: true }) === 1;
  if (foreignKeysEnabled) {
    database.pragma("foreign_keys = OFF");
  }

  try {
    const rewrite = database.transaction(() => {
      database.exec(`
        CREATE TABLE lanes__new (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          position INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO lanes__new (id, project_id, name, position, created_at, updated_at)
        SELECT id, project_id, name, position, created_at, updated_at
        FROM lanes;

        CREATE TABLE tasks__new (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          lane_id TEXT REFERENCES lanes(id) ON DELETE CASCADE,
          parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          ticket_number INTEGER,
          position INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO tasks__new (
          id,
          project_id,
          lane_id,
          parent_task_id,
          title,
          body,
          ticket_number,
          position,
          created_at,
          updated_at
        )
        SELECT
          id,
          project_id,
          lane_id,
          parent_task_id,
          title,
          body,
          ticket_number,
          position,
          created_at,
          updated_at
        FROM tasks;

        DROP TABLE tasks;
        DROP TABLE lanes;

        ALTER TABLE lanes__new RENAME TO lanes;
        ALTER TABLE tasks__new RENAME TO tasks;
      `);

      ensureLaneOnlyIndexes(database);
    });

    rewrite();
  } finally {
    if (foreignKeysEnabled) {
      database.pragma("foreign_keys = ON");
    }
  }
}

function markLatestDrizzleMigrationApplied(database: Database.Database) {
  const latestMigration = getLatestMigrationEntry();

  database.exec(`
    CREATE TABLE IF NOT EXISTS ${DRIZZLE_MIGRATIONS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      hash TEXT NOT NULL,
      created_at NUMERIC
    );
  `);

  const existing = database
    .prepare(`SELECT 1 FROM ${DRIZZLE_MIGRATIONS_TABLE} WHERE created_at = ? LIMIT 1`)
    .get(latestMigration.createdAt);
  if (existing) {
    return;
  }

  database
    .prepare(`INSERT INTO ${DRIZZLE_MIGRATIONS_TABLE} ("hash", "created_at") VALUES (?, ?)`)
    .run(latestMigration.hash, latestMigration.createdAt);
}

function bootstrapLegacyDatabase(database: Database.Database) {
  if (tableExists(database, DRIZZLE_MIGRATIONS_TABLE) || !hasAnyApplicationTables(database)) {
    return;
  }

  createLegacyCompatTables(database);
  ensureLegacyCompatColumns(database);
  ensureLegacyCompatIndexes(database);
  backfillLegacyLaneData(database);
  rewriteLaneOnlySchema(database);
  markLatestDrizzleMigrationApplied(database);
}

export function createDatabase(sqlitePath: string): DatabaseServices {
  if (sqlitePath !== ":memory:") {
    mkdirSync(dirname(sqlitePath), { recursive: true });
  }

  const database = new Database(sqlitePath);
  database.pragma("foreign_keys = ON");
  bootstrapLegacyDatabase(database);

  const services = {
    database,
    db: drizzle(database, {
      schema: {
        apiTokens,
        lanes,
        projects,
        sessions,
        taskTags,
        tasks,
        users
      }
    })
  };

  migrate(services.db, {
    migrationsFolder: DRIZZLE_MIGRATIONS_PATH
  });
  backfillTicketIds(services.db);

  return services;
}
