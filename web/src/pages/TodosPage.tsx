import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";

import type { Task, TodoProjectGroup } from "../api";
import { getTaskTagStyle } from "../app/tag-colors";
import { getTodoStatus, todoQueryOptions } from "../app/todo-status";
import { formatDateTime, formatSingleTagInput, itemStyle, normalizeTagKey, parseSingleTagInput } from "../app/utils";
import { BoardSkeleton, EmptyState, ErrorBanner } from "../components/ui";

type TodoTaskDisplayGroup = {
  displaySubtasks: Task[];
  shouldDisplay: boolean;
  subtasks: Task[];
  task: Task;
};

type TodoProjectDisplayGroup = TodoProjectGroup & {
  displayTasks: TodoTaskDisplayGroup[];
};

function summarizeTaskBody(body: string) {
  return body.replace(/\s+/g, " ").trim();
}

function buildTaskCollections(tasks: Task[]) {
  const taskIds = new Set(tasks.map((task) => task.id));
  const topLevelTasks: Task[] = [];
  const subtasksByParent = new Map<string, Task[]>();

  tasks.forEach((task) => {
    if (task.parentTaskId && taskIds.has(task.parentTaskId)) {
      const subtasks = subtasksByParent.get(task.parentTaskId) ?? [];
      subtasks.push(task);
      subtasksByParent.set(task.parentTaskId, subtasks);
      return;
    }

    topLevelTasks.push(task);
  });

  return {
    subtasksByParent,
    topLevelTasks
  };
}

function taskMatchesFilters(task: Task, searchValue: string, activeTagKey: string | null) {
  const haystack =
    `${task.ticketId}\n${task.title}\n${task.body}\n${task.tags.map((tag) => tag.label).join("\n")}`.toLowerCase();
  const matchesSearch = searchValue.length === 0 || haystack.includes(searchValue);

  if (!matchesSearch) {
    return false;
  }

  if (activeTagKey === null) {
    return true;
  }

  return task.tags.some((tag) => normalizeTagKey(tag.label) === activeTagKey);
}

function TodoTaskCard({
  activeTagKey,
  isSubtask = false,
  onOpen,
  onTagSelect,
  subtasks,
  task,
  taskIndex
}: {
  activeTagKey: string | null;
  isSubtask?: boolean;
  onOpen: (task: Task) => void;
  onTagSelect: (tagLabel: string) => void;
  subtasks: Task[];
  task: Task;
  taskIndex: number;
}) {
  const bodyPreview = summarizeTaskBody(task.body);

  return (
    <article
      className={`task-card${isSubtask ? " task-card--subtask" : ""}`}
      data-testid={`todo-task-card-${task.id}`}
      style={itemStyle(taskIndex)}
    >
      <div
        aria-label={`Open todo ${task.ticketId}`}
        className="task-card__surface"
        onClick={() => onOpen(task)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen(task);
          }
        }}
        role="button"
        tabIndex={0}
      >
        <p className="task-card__title">
          <span className="task-card__ticket-id">[{task.ticketId}]</span> {task.title}
        </p>
        {bodyPreview ? <p className="todo-task-card__body">{bodyPreview}</p> : null}
        <div className="todo-task-card__footer">
          {task.tags.length > 0 ? (
            <div className="task-card__tags">
              {task.tags.map((tag) => (
                <button
                  className={`task-tag${activeTagKey === normalizeTagKey(tag.label) ? " is-active" : ""}`}
                  key={tag.label}
                  onClick={(event) => {
                    event.stopPropagation();
                    onTagSelect(tag.label);
                  }}
                  style={getTaskTagStyle(tag.color)}
                  type="button"
                >
                  {tag.label}
                </button>
              ))}
            </div>
          ) : (
            <span />
          )}
          <span className="task-card__timestamp">Updated {formatDateTime(task.updatedAt)}</span>
        </div>
      </div>
      {subtasks.length > 0 ? (
        <div className="task-card__subtasks">
          {subtasks.map((subtask, subtaskIndex) => (
            <TodoTaskCard
              activeTagKey={activeTagKey}
              isSubtask
              key={subtask.id}
              onOpen={onOpen}
              onTagSelect={onTagSelect}
              subtasks={[]}
              task={subtask}
              taskIndex={subtaskIndex}
            />
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function TodosPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const status = getTodoStatus(searchParams.get("status"));
  const isTodoStatus = status.key === "todo";
  const todosQuery = useQuery(todoQueryOptions(status.key));
  const todoGroups = todosQuery.data ?? [];
  const todoSearch = searchParams.get("q")?.trim().toLowerCase() ?? "";
  const activeTagFilter = parseSingleTagInput(searchParams.get("tags") ?? "");
  const activeTagKey = activeTagFilter ? normalizeTagKey(activeTagFilter) : null;
  const isFiltered = todoSearch.length > 0 || activeTagKey !== null;

  const visibleTodoGroups = useMemo<TodoProjectDisplayGroup[]>(
    () =>
      todoGroups
        .map((group) => {
          const { subtasksByParent, topLevelTasks } = buildTaskCollections(group.tasks);
          const displayTasks = topLevelTasks
            .map((task) => {
              const subtasks = subtasksByParent.get(task.id) ?? [];
              const displaySubtasks = subtasks.filter((subtask) =>
                taskMatchesFilters(subtask, todoSearch, activeTagKey)
              );
              const shouldDisplay =
                !isFiltered ||
                taskMatchesFilters(task, todoSearch, activeTagKey) ||
                displaySubtasks.length > 0;

              return {
                displaySubtasks,
                shouldDisplay,
                subtasks,
                task
              };
            })
            .filter((taskGroup) => taskGroup.shouldDisplay);

          return {
            ...group,
            displayTasks
          };
        })
        .filter((group) => group.displayTasks.length > 0),
    [activeTagKey, isFiltered, todoGroups, todoSearch]
  );

  function navigateToTask(group: TodoProjectGroup, task: Task) {
    navigate(`/projects/${group.projectTicketPrefix}/${encodeURIComponent(task.ticketId)}`);
  }

  function selectTagFilter(tagLabel: string) {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tags", formatSingleTagInput(tagLabel));
    setSearchParams(nextParams, { replace: true });
  }

  return (
    <main className="page-shell page-shell--todos">
      <title>{isTodoStatus ? "All TODOs | BBTodo" : `${status.label} tasks | BBTodo`}</title>
      {todosQuery.error ? <ErrorBanner error={todosQuery.error} /> : null}

      {todosQuery.isPending ? <BoardSkeleton /> : null}

      {!todosQuery.isPending && !todosQuery.error && todoGroups.length === 0 ? (
        <EmptyState
          copy={isTodoStatus
            ? "Every board is either empty or already moving beyond the Todo lane."
            : `Tasks will appear here when they enter a ${status.label} lane.`}
          eyebrow="All clear"
          title={isTodoStatus ? "No TODOs yet." : `No tasks in ${status.label}.`}
        />
      ) : null}

      {!todosQuery.isPending && todoGroups.length > 0 && visibleTodoGroups.length === 0 ? (
        <EmptyState
          copy="Try a different search term or remove the active tag filter."
          eyebrow="No matches"
          title={isTodoStatus ? "No TODOs match the current filters." : "No tasks match the current filters."}
        />
      ) : null}

      {!todosQuery.isPending && visibleTodoGroups.length > 0 ? (
        <section className="todos-project-list">
          {visibleTodoGroups.map((group, index) => (
            <article
              className="todos-project"
              data-testid={`todo-project-group-${group.projectId}`}
              key={group.projectId}
              style={itemStyle(index)}
            >
              <header className="todos-project__header">
                <button
                  aria-label={`Open board ${group.projectName}`}
                  className="todos-project__link"
                  onClick={() => navigate(`/projects/${group.projectTicketPrefix}`)}
                  type="button"
                >
                  <div className="todos-project__title-row">
                    <h2>{group.projectName}</h2>
                    <span className="todos-project__eyebrow">{group.projectTicketPrefix}</span>
                  </div>
                </button>
                <div className="todos-project__meta">
                  <span className="label-chip label-chip--soft">{group.tasks.length} total</span>
                </div>
              </header>
              <div className="todos-project__task-list">
                {group.displayTasks.map((displayTask, taskIndex) => (
                  <TodoTaskCard
                    activeTagKey={activeTagKey}
                    key={displayTask.task.id}
                    onOpen={(task) => navigateToTask(group, task)}
                    onTagSelect={selectTagFilter}
                    subtasks={displayTask.displaySubtasks}
                    task={displayTask.task}
                    taskIndex={taskIndex}
                  />
                ))}
              </div>
            </article>
          ))}
        </section>
      ) : null}
    </main>
  );
}
