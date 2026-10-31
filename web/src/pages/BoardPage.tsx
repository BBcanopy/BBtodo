import {
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import { flushSync } from "react-dom";
import {
  closestCorners,
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CSS } from "@dnd-kit/utilities";

import {
  api,
  isApiError,
  type BoardLane,
  type Project,
  type Task,
  type TaskTag,
  type TaskTagColor
} from "../api";
import {
  getRandomTaskTagColor,
  getTaskTagStyle,
  taskTagColorOptions
} from "../app/tag-colors";
import {
  formatSingleTagInput,
  getTaskInputLabel,
  isDoneLaneName,
  isProtectedLaneName,
  itemStyle,
  normalizeLaneName,
  normalizeTagKey,
  parseSingleTagInput,
  parseTagInput
} from "../app/utils";
import {
  BoardSkeleton,
  CloseIcon,
  ContractIcon,
  ErrorBanner,
  ExpandIcon,
  PlusIcon,
  ToastNotice,
  TrashIcon
} from "../components/ui";
import { useDismissableLayer } from "../hooks/useDismissableLayer";
import {
  applyPendingTaskMoves,
  buildSubtaskIdsByParent,
  buildTopLevelTaskIdsByLane,
  canTaskBecomeSubtask,
  canTaskNestUnderParent,
  compareTasksInLane,
  findTaskLocation,
  getTaskDropSlotId,
  getTaskMoveAffectedTaskIds,
  getTaskPreviewUpdatedAt,
  resolveTaskDragPreview,
  type PendingTaskMove,
  type TaskCardDropPosition,
  type TaskDragOverData,
  type TaskDragPreview
} from "./boardTaskDrag";

type TaskEditorView = "preview" | "source";
type BoardToast = {
  message: string;
  title: string;
  tone: "danger" | "success";
};
type TaskProjectMovePreview = {
  lane: BoardLane;
  usesFallback: boolean;
};
type TaskMoveMutationVariables = {
  affectedTaskIds: string[];
  laneId: string;
  parentTaskId: string | null;
  position: number;
  previewUpdatedAt?: string | null;
  taskId: string;
};

const taskSortableTransition = {
  duration: 220,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)"
};

const taskDropAnimation = {
  duration: 220,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)"
};
const taskMeasuring = {
  droppable: {
    strategy: MeasuringStrategy.Always
  }
} as const;
const taskMouseActivationDistance = 8;
const taskTouchActivationDelayMs = 180;
const taskTouchActivationTolerance = 8;
const taskClickSuppressDurationMs = 300;
const mobileBoardBreakpointQuery = "(max-width: 860px)";

const projectTicketPrefixPattern = /^[A-Z]{2,4}$/;

function buildBoardPath(projectTicketPrefix: string, ticketId?: string) {
  return ticketId
    ? `/projects/${projectTicketPrefix}/${encodeURIComponent(ticketId)}`
    : `/projects/${projectTicketPrefix}`;
}

function resolveDestinationLanePreview(
  destinationProject: Project,
  sourceLaneName: string | null
): TaskProjectMovePreview | null {
  const normalizedSourceLaneName = normalizeLaneName(sourceLaneName ?? "");
  const matchingLane =
    normalizedSourceLaneName.length > 0
      ? destinationProject.laneSummaries.find(
          (lane) => normalizeLaneName(lane.name) === normalizedSourceLaneName
        ) ?? null
      : null;
  const fallbackLane =
    destinationProject.laneSummaries.find((lane) => normalizeLaneName(lane.name) === "todo") ??
    destinationProject.laneSummaries[0] ??
    null;
  const lane = matchingLane ?? fallbackLane;

  if (!lane) {
    return null;
  }

  return {
    lane,
    usesFallback: matchingLane === null
  };
}

function toSearchString(searchParams: URLSearchParams) {
  const serializedParams = searchParams.toString();
  return serializedParams ? `?${serializedParams}` : "";
}

function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (onStoreChange) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return () => undefined;
      }

      const mediaQueryList = window.matchMedia(query);
      const handleChange = () => onStoreChange();

      if (typeof mediaQueryList.addEventListener === "function") {
        mediaQueryList.addEventListener("change", handleChange);

        return () => {
          mediaQueryList.removeEventListener("change", handleChange);
        };
      }

      mediaQueryList.addListener(handleChange);

      return () => {
        mediaQueryList.removeListener(handleChange);
      };
    },
    () =>
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(query).matches
        : false,
    () => false
  );
}

function getTaskTrashDropTargetId(laneId: string) {
  return `task-trash:${laneId}`;
}

function getLaneIdFromTaskTrashDropTargetId(dropTargetId: string | number) {
  const normalizedDropTargetId = String(dropTargetId);

  return normalizedDropTargetId.startsWith("task-trash:")
    ? normalizedDropTargetId.slice("task-trash:".length)
    : null;
}

const taskCollisionDetection: CollisionDetection = (args) => {
  function getCollisionContainer(collisionId: string | number) {
    return args.droppableContainers.find((droppableContainer) => droppableContainer.id === collisionId);
  }

  function getPointerDistanceFromContainer(collisionId: string | number) {
    const pointer =
      args.pointerCoordinates ?? {
        x: args.collisionRect.left + args.collisionRect.width / 2,
        y: args.collisionRect.top + args.collisionRect.height / 2
      };
    const rect = getCollisionContainer(collisionId)?.rect.current;
    if (!rect) {
      return Number.POSITIVE_INFINITY;
    }

    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    return Math.hypot(pointer.x - centerX, pointer.y - centerY);
  }

  const pointerHits = pointerWithin(args);
  if (pointerHits.length > 0) {
    const trashHits = pointerHits.filter((collision) => {
      const container = getCollisionContainer(collision.id);

      return container?.data.current?.type === "trash";
    });

    if (trashHits.length > 0) {
      return trashHits;
    }

    const nestTargetHits = pointerHits.filter((collision) => {
      const container = getCollisionContainer(collision.id);

      return container?.data.current?.type === "nest-target";
    });

    if (nestTargetHits.length > 0) {
      return nestTargetHits
        .slice()
        .sort(
          (left, right) =>
            getPointerDistanceFromContainer(left.id) - getPointerDistanceFromContainer(right.id)
        );
    }

    const slotHits = pointerHits.filter((collision) => {
      const container = getCollisionContainer(collision.id);

      return container?.data.current?.type === "slot";
    });

    if (slotHits.length > 0) {
      return slotHits;
    }

    const taskHits = pointerHits.filter((collision) => {
      const container = getCollisionContainer(collision.id);

      return container?.data.current?.type === "task";
    });

    if (taskHits.length > 0) {
      const taskHitDetails = taskHits
        .map((collision) => {
          const container = getCollisionContainer(collision.id);
          const rect = container?.rect.current;
          const data = container?.data.current;

          return {
            area: rect ? rect.width * rect.height : Number.POSITIVE_INFINITY,
            collision,
            parentTaskId:
              typeof data?.parentTaskId === "string" ? String(data.parentTaskId) : null,
            taskId: typeof data?.taskId === "string" ? String(data.taskId) : null
          };
        })
        .filter((taskHit) => taskHit.taskId !== null);
      const mostSpecificTaskHits = taskHitDetails.filter(
        (taskHit) =>
          !taskHitDetails.some((candidate) => candidate.parentTaskId === taskHit.taskId)
      );

      if (mostSpecificTaskHits.length > 0) {
        return mostSpecificTaskHits
          .slice()
          .sort((left, right) => left.area - right.area)
          .map((taskHit) => taskHit.collision);
      }

      return taskHits;
    }

    return pointerHits;
  }

  return closestCorners(args);
};

function mergeUniqueTags(currentTags: TaskTag[], nextValue: string, color: TaskTagColor) {
  const seen = new Set(currentTags.map((tag) => normalizeTagKey(tag.label)));
  const additions: TaskTag[] = [];

  parseTagInput(nextValue).forEach((tag) => {
    const key = normalizeTagKey(tag);
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    additions.push({
      color,
      label: tag
    });
  });

  return additions.length > 0 ? [...currentTags, ...additions] : currentTags;
}

type TaskEditorDraft = {
  body: string;
  tags: TaskTag[];
  title: string;
};

type TaskEditorSaveWaiter = {
  reject: (error: unknown) => void;
  resolve: (task: Task) => void;
};

type TaskEditorSaveRequest = {
  draft: TaskEditorDraft;
  waiters: TaskEditorSaveWaiter[];
};

function cloneTaskTags(tags: TaskTag[]) {
  return tags.map((tag) => ({ ...tag }));
}

function cloneTask(task: Task) {
  return {
    ...task,
    tags: cloneTaskTags(task.tags)
  };
}

function toTaskEditorDraft(task: Pick<Task, "body" | "tags" | "title">): TaskEditorDraft {
  return {
    body: task.body,
    tags: cloneTaskTags(task.tags),
    title: task.title.trim()
  };
}

function areTaskTagsEqual(left: TaskTag[], right: TaskTag[]) {
  return (
    left.length === right.length &&
    left.every(
      (tag, index) => tag.color === right[index]?.color && tag.label === right[index]?.label
    )
  );
}

function areTaskEditorDraftsEqual(left: TaskEditorDraft, right: TaskEditorDraft) {
  return left.body === right.body && left.title === right.title && areTaskTagsEqual(left.tags, right.tags);
}

function mergeSavedTaskIntoTasks(tasks: Task[], updatedTask: Task) {
  const colorByTagKey = new Map(
    updatedTask.tags.map((tag) => [normalizeTagKey(tag.label), tag.color] as const)
  );
  let hasChanges = false;

  const nextTasks = tasks.map((task) => {
    if (task.id === updatedTask.id) {
      hasChanges = true;
      return updatedTask;
    }

    let tagColorsChanged = false;
    const nextTags = task.tags.map((taskTag) => {
      const nextColor = colorByTagKey.get(normalizeTagKey(taskTag.label));
      if (!nextColor || nextColor === taskTag.color) {
        return taskTag;
      }

      tagColorsChanged = true;
      return {
        ...taskTag,
        color: nextColor
      };
    });

    if (!tagColorsChanged) {
      return task;
    }

    hasChanges = true;
    return {
      ...task,
      tags: nextTags
    };
  });

  return hasChanges ? nextTasks : tasks;
}

function sortTasksForLane(tasks: Task[], laneName: string) {
  return tasks
    .slice()
    .sort((left, right) => compareTasksInLane(left, right, isDoneLaneName(laneName)));
}

function reindexTaskPositions(
  tasks: Task[],
  laneNameById: ReadonlyMap<string, string>,
  projectId: string,
  laneId: string,
  parentTaskId: string | null
) {
  const laneName = laneNameById.get(laneId) ?? "";

  sortTasksForLane(
    tasks.filter(
      (task) =>
        task.projectId === projectId && task.laneId === laneId && task.parentTaskId === parentTaskId
    ),
    laneName
  ).forEach((task, index) => {
    task.position = index;
  });
}

function removeDeletedTaskFromTasks(
  tasks: Task[],
  taskId: string,
  laneNameById: ReadonlyMap<string, string>
) {
  const nextTasks = tasks.map((task) => cloneTask(task));
  const removedTaskIndex = nextTasks.findIndex((task) => task.id === taskId);

  if (removedTaskIndex === -1) {
    return tasks;
  }

  const [removedTask] = nextTasks.splice(removedTaskIndex, 1);
  if (!removedTask.laneId) {
    return nextTasks;
  }

  if (removedTask.parentTaskId !== null) {
    reindexTaskPositions(
      nextTasks,
      laneNameById,
      removedTask.projectId,
      removedTask.laneId,
      removedTask.parentTaskId
    );
    return nextTasks;
  }

  const laneName = laneNameById.get(removedTask.laneId) ?? "";
  const childTasks = sortTasksForLane(
    nextTasks.filter(
      (task) => task.projectId === removedTask.projectId && task.parentTaskId === removedTask.id
    ),
    laneName
  );

  if (childTasks.length > 0) {
    const childTaskIds = new Set(childTasks.map((task) => task.id));
    const promotedTopLevelTasks = sortTasksForLane(
      nextTasks.filter(
        (task) =>
          task.projectId === removedTask.projectId &&
          task.laneId === removedTask.laneId &&
          task.parentTaskId === null &&
          !childTaskIds.has(task.id)
      ),
      laneName
    );
    const insertIndex = Math.max(0, Math.min(removedTask.position, promotedTopLevelTasks.length));

    childTasks.forEach((task) => {
      task.parentTaskId = null;
    });
    promotedTopLevelTasks.splice(insertIndex, 0, ...childTasks);
    promotedTopLevelTasks.forEach((task, index) => {
      task.position = index;
    });
    return nextTasks;
  }

  reindexTaskPositions(nextTasks, laneNameById, removedTask.projectId, removedTask.laneId, null);
  return nextTasks;
}

function updateLaneTaskCounts(lanes: BoardLane[], laneId: string, delta: number) {
  let hasChanges = false;
  const nextLanes = lanes.map((lane) => {
    if (lane.id !== laneId) {
      return lane;
    }

    hasChanges = true;
    return {
      ...lane,
      taskCount: Math.max(0, lane.taskCount + delta)
    };
  });

  return hasChanges ? nextLanes : lanes;
}

function updateProjectLaneTaskCounts(project: Project, laneId: string, delta: number) {
  const nextLaneSummaries = updateLaneTaskCounts(project.laneSummaries, laneId, delta);

  return nextLaneSummaries === project.laneSummaries
    ? project
    : {
        ...project,
        laneSummaries: nextLaneSummaries
      };
}

function listSuggestedTags(tasks: Task[]) {
  const tagsByKey = new Map<string, TaskTag>();

  tasks.forEach((task) => {
    task.tags.forEach((tag) => {
      const key = normalizeTagKey(tag.label);
      if (!key || tagsByKey.has(key)) {
        return;
      }

      tagsByKey.set(key, tag);
    });
  });

  return Array.from(tagsByKey.values()).sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { sensitivity: "base" })
  );
}

function createNativeDragPreview(node: HTMLElement) {
  const preview = node.cloneNode(true);
  if (!(preview instanceof HTMLElement)) {
    return null;
  }

  const bounds = node.getBoundingClientRect();
  preview.classList.add("board-drag-preview");
  preview.style.width = `${bounds.width}px`;
  preview.style.height = `${bounds.height}px`;
  preview.style.position = "fixed";
  preview.style.top = "-10000px";
  preview.style.left = "-10000px";
  preview.style.margin = "0";
  preview.style.pointerEvents = "none";
  preview.style.zIndex = "9999";
  preview.style.transform = "none";
  preview.style.animation = "none";
  preview.style.transition = "none";
  document.body.append(preview);

  return preview;
}

function getPreferredLaneDeleteDestination(laneId: string, lanes: BoardLane[]) {
  return (
    lanes.find((candidate) => candidate.id !== laneId && normalizeTagKey(candidate.name) === "todo") ??
    lanes.find((candidate) => candidate.id !== laneId) ??
    null
  );
}

function LaneHeader({
  destinationLanes,
  isDeletePending,
  isDragDisabled,
  isProtected,
  isTaskDeletePending,
  isTaskDragging,
  isTaskTrashVisible,
  lane,
  onAddTask,
  onCancelTaskDelete,
  onDelete,
  onConfirmTaskDelete,
  onDragEnd,
  onDragStart,
  pendingTaskDelete,
  useFloatingTaskTrash
}: {
  destinationLanes: BoardLane[];
  isDeletePending: boolean;
  isDragDisabled: boolean;
  isProtected: boolean;
  isTaskDeletePending: boolean;
  isTaskDragging: boolean;
  isTaskTrashVisible: boolean;
  lane: BoardLane;
  onAddTask: () => void;
  onCancelTaskDelete: () => void;
  onDelete: (destinationLaneId?: string) => void;
  onConfirmTaskDelete: (taskId: string) => void;
  onDragEnd: () => void;
  onDragStart: (event: DragEvent<HTMLElement>, laneId: string) => void;
  pendingTaskDelete: Task | null;
  useFloatingTaskTrash: boolean;
}) {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  const isHeaderTaskTrashEnabled = isTaskTrashVisible && !useFloatingTaskTrash;
  const { isOver: isTaskTrashOver, setNodeRef: setTaskTrashRef } = useDroppable({
    id: getTaskTrashDropTargetId(lane.id),
    data: {
      laneId: lane.id,
      type: "trash"
    },
    disabled: !isHeaderTaskTrashEnabled
  });
  const preferredDestinationId = getPreferredLaneDeleteDestination(lane.id, destinationLanes)?.id ?? "";
  const [destinationLaneId, setDestinationLaneId] = useState(preferredDestinationId);
  const requiresDestination = lane.taskCount > 0;
  const showAddTaskAction = !isTaskDragging && !pendingTaskDelete;
  const showLaneDeleteAction = !isTaskDragging && !pendingTaskDelete && !isProtected;
  const showTaskTrashState = !useFloatingTaskTrash && (isTaskTrashVisible || pendingTaskDelete !== null);
  const isTaskTrashActive =
    !useFloatingTaskTrash && ((isTaskTrashVisible && isTaskTrashOver) || pendingTaskDelete !== null);

  useDismissableLayer(isConfirmOpen, confirmRef, () => setIsConfirmOpen(false));

  useEffect(() => {
    if (!isConfirmOpen) {
      return;
    }

    setDestinationLaneId(preferredDestinationId);
  }, [isConfirmOpen, preferredDestinationId]);

  useEffect(() => {
    if (isTaskDragging || pendingTaskDelete) {
      setIsConfirmOpen(false);
    }
  }, [isTaskDragging, pendingTaskDelete]);

  return (
    <div
      aria-label={`Reorder lane ${lane.name}`}
      className={`board-column__header${isDragDisabled ? "" : " is-draggable"}${showAddTaskAction ? " has-add-task-action" : ""}${showLaneDeleteAction ? " has-lane-delete-action" : ""}${showTaskTrashState ? " is-task-trash-visible" : ""}${isTaskTrashActive ? " is-task-trash-active" : ""}`}
      data-testid={`lane-header-${lane.id}`}
      draggable={!isDragDisabled}
      onDragEnd={onDragEnd}
      onDragStart={(event) => onDragStart(event, lane.id)}
      ref={useFloatingTaskTrash ? undefined : setTaskTrashRef}
    >
      <div className="board-column__header-copy">
        <h2>{lane.name}</h2>
      </div>
      <div className="lane-header__actions" ref={confirmRef}>
        {!useFloatingTaskTrash ? (
          <LaneTaskTrashTarget
            isDeletePending={isTaskDeletePending}
            isDropActive={isTaskTrashActive}
            isVisible={showTaskTrashState}
            laneId={lane.id}
            onCancel={onCancelTaskDelete}
            onConfirm={onConfirmTaskDelete}
            pendingTask={pendingTaskDelete}
          />
        ) : null}
        {showAddTaskAction ? (
          <button
            aria-label={`Add task to ${lane.name}`}
            className="icon-button lane-add-task-button"
            data-testid={`add-task-button-${lane.id}`}
            draggable={false}
            onClick={(event) => {
              event.stopPropagation();
              onAddTask();
            }}
            onDragStart={(event) => event.preventDefault()}
            onPointerDown={(event) => event.stopPropagation()}
            title={`Add task to ${lane.name}`}
            type="button"
          >
            <PlusIcon />
          </button>
        ) : null}
        {showLaneDeleteAction ? (
          <button
            aria-haspopup="dialog"
            aria-expanded={isConfirmOpen}
            aria-label={`Delete lane ${lane.name}`}
            className="icon-button danger-button lane-delete-button"
            draggable={false}
            onClick={(event) => {
              event.stopPropagation();
              setIsConfirmOpen((current) => !current);
            }}
            onDragStart={(event) => event.preventDefault()}
            onPointerDown={(event) => event.stopPropagation()}
            type="button"
          >
            <TrashIcon />
          </button>
        ) : null}
        {showLaneDeleteAction && isConfirmOpen ? (
          <div
            aria-label={`Delete lane ${lane.name}`}
            className="task-delete-popover lane-delete-popover"
            draggable={false}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            role="alertdialog"
          >
            <p>Delete this lane?</p>
            {requiresDestination ? (
              <label className="lane-delete-popover__field">
                <span>Move tasks to</span>
                <select
                  aria-label={`Move tasks from ${lane.name} to`}
                  onChange={(event) => setDestinationLaneId(event.target.value)}
                  value={destinationLaneId}
                >
                  {destinationLanes.map((destinationLane) => (
                    <option key={destinationLane.id} value={destinationLane.id}>
                      {destinationLane.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className="task-delete-popover__actions">
              <button
                className="text-button"
                disabled={isDeletePending}
                onClick={(event) => {
                  event.stopPropagation();
                  setIsConfirmOpen(false);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                type="button"
              >
                Cancel
              </button>
              <button
                className="ghost-button danger-button"
                disabled={isDeletePending || (requiresDestination && destinationLaneId.length === 0)}
                onClick={(event) => {
                  event.stopPropagation();
                  setIsConfirmOpen(false);
                  onDelete(requiresDestination ? destinationLaneId : undefined);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                type="button"
              >
                {isDeletePending ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LaneDropArea({
  children,
  laneId
}: {
  children: ReactNode;
  laneId: string;
}) {
  const laneDropTargetId = `lane:${laneId}`;
  const { setNodeRef } = useDroppable({
    id: laneDropTargetId,
    data: {
      laneId,
      type: "lane"
    }
  });

  return (
    <div className="board-column__content" ref={setNodeRef}>
      {children}
    </div>
  );
}

function TaskDropSlot({
  isActive,
  isDragReady,
  isInteractive = true,
  isVisible,
  laneId,
  parentTaskId,
  position
}: {
  isActive: boolean;
  isDragReady: boolean;
  isInteractive?: boolean;
  isVisible: boolean;
  laneId: string;
  parentTaskId: string | null;
  position: number;
}) {
  const slotDropTargetId = getTaskDropSlotId(laneId, parentTaskId, position);
  const { isOver, setNodeRef } = useDroppable({
    id: slotDropTargetId,
    disabled: !isInteractive || !isVisible,
    data: {
      laneId,
      parentTaskId,
      position,
      type: "slot"
    }
  });

  const showSlot = isVisible || isActive;
  const isSlotActive = isActive || (isInteractive && isOver);
  if (!showSlot) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      className={`task-drop-slot${isDragReady ? " is-drag-ready" : ""}${isSlotActive ? " is-active" : ""}`}
      data-testid={
        parentTaskId
          ? `task-drop-slot-${parentTaskId}-${position}`
          : `task-drop-slot-${laneId}-${position}`
      }
      ref={setNodeRef}
    />
  );
}

function TaskCardPreview({
  activeTagKey,
  task
}: {
  activeTagKey: string | null;
  task: Task;
}) {
  return (
    <article className="task-card task-card--drag-overlay">
      <p className="task-card__title">
        <span className="task-card__ticket-id">[{task.ticketId}]</span> {task.title}
      </p>
      {task.tags.length > 0 ? (
        <div className="task-card__tags">
          {task.tags.map((tag) => (
            <span
              className={`task-tag${activeTagKey === normalizeTagKey(tag.label) ? " is-active" : ""}`}
              key={tag.label}
              style={getTaskTagStyle(tag.color)}
            >
              {tag.label}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function TaskCard({
  activePreviewSlotId,
  activeTagKey,
  dropPositionsByTaskId,
  dropPosition,
  isBoardDragDisabled,
  isNestTarget,
  nestTargetMode = "zone",
  isTaskDragging,
  laneId,
  onOpen,
  onTagSelect,
  pendingMoveTaskIds,
  showNestTarget,
  showSubtaskSlots,
  subtasks,
  displaySubtasks,
  task,
  taskIndex
}: {
  activePreviewSlotId: string | null;
  activeTagKey: string | null;
  dropPositionsByTaskId: ReadonlyMap<string, TaskCardDropPosition>;
  dropPosition: TaskCardDropPosition | null;
  isBoardDragDisabled: boolean;
  isNestTarget: boolean;
  nestTargetMode?: "body" | "zone";
  isTaskDragging: boolean;
  laneId: string;
  onOpen: (task: Task) => void;
  onTagSelect: (tag: string) => void;
  pendingMoveTaskIds: ReadonlySet<string>;
  showNestTarget: boolean;
  showSubtaskSlots: boolean;
  subtasks: Task[];
  displaySubtasks: Task[];
  task: Task;
  taskIndex: number;
}) {
  const suppressClickUntilRef = useRef(0);
  const touchPressStartedAtRef = useRef<number | null>(null);
  const wasDraggingRef = useRef(false);
  const nestTargetDropTargetId = `nest:${task.id}`;
  const isDragDisabled = isBoardDragDisabled || pendingMoveTaskIds.has(task.id);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: isDragDisabled,
    transition: taskSortableTransition,
    data: {
      laneId,
      parentTaskId: task.parentTaskId,
      taskId: task.id,
      type: "task"
    }
  });
  const { setNodeRef: setNestTargetRef } = useDroppable({
    id: nestTargetDropTargetId,
    disabled: !showNestTarget,
    data: {
      laneId,
      parentTaskId: task.id,
      taskId: task.id,
      type: "nest-target"
    }
  });

  const dropShiftClass =
    dropPosition === "before"
      ? " task-card--shift-down"
      : dropPosition === "after"
        ? " task-card--shift-up"
        : "";
  const showSubtaskPreviewContainer =
    subtasks.length > 0 || activePreviewSlotId === getTaskDropSlotId(laneId, task.id, 0);

  function suppressTaskOpen(durationMs = taskClickSuppressDurationMs) {
    suppressClickUntilRef.current = Math.max(suppressClickUntilRef.current, Date.now() + durationMs);
  }

  useEffect(() => {
    if (isDragging) {
      wasDraggingRef.current = true;
      suppressTaskOpen();
      return;
    }

    if (wasDraggingRef.current) {
      wasDraggingRef.current = false;
      suppressTaskOpen();
    }
  }, [isDragging]);

  return (
    <article
      className={`task-card${isDragDisabled ? "" : " is-draggable"}${isDragging ? " is-dragging" : ""}${task.parentTaskId ? " task-card--subtask" : ""}${subtasks.length > 0 ? " has-subtasks" : ""}${isNestTarget ? " is-nest-target" : ""}${dropPosition ? ` task-card--drop-${dropPosition}` : ""}${dropShiftClass}`}
      data-testid={`task-card-${task.id}`}
      ref={setNodeRef}
      style={{
        ...itemStyle(taskIndex),
        transform: isTaskDragging ? undefined : CSS.Transform.toString(transform),
        transition: isTaskDragging ? undefined : transition
      }}
    >
      <div className="task-card__surface-wrap">
        {showNestTarget ? (
          <div
            aria-hidden="true"
            className={`task-card__nest-target task-card__nest-target--${nestTargetMode}${isNestTarget ? " is-active" : ""}`}
            ref={setNestTargetRef}
          />
        ) : null}
        <div
          {...attributes}
          {...listeners}
          className="task-card__surface"
          onTouchCancelCapture={() => {
            touchPressStartedAtRef.current = null;
            if (isDragging || wasDraggingRef.current) {
              suppressTaskOpen();
            }
          }}
          onTouchEndCapture={() => {
            const touchPressStartedAt = touchPressStartedAtRef.current;

            touchPressStartedAtRef.current = null;
            if (
              touchPressStartedAt !== null &&
              Date.now() - touchPressStartedAt >= taskTouchActivationDelayMs
            ) {
              suppressTaskOpen();
            }
          }}
          onTouchStartCapture={() => {
            touchPressStartedAtRef.current = Date.now();
          }}
          onClick={() => {
            if (Date.now() < suppressClickUntilRef.current) {
              return;
            }

            onOpen(task);
          }}
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
          {task.tags.length > 0 ? (
            <div className="task-card__tags">
              {task.tags.map((tag) => (
                <button
                  className={`task-tag${activeTagKey === normalizeTagKey(tag.label) ? " is-active" : ""}`}
                  data-no-dnd="true"
                  key={tag.label}
                  onClick={(event) => {
                    event.stopPropagation();
                    onTagSelect(tag.label);
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  style={getTaskTagStyle(tag.color)}
                  type="button"
                >
                  {tag.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {showSubtaskPreviewContainer ? (
        <div className="task-card__subtasks">
          <SortableContext items={subtasks.map((subtask) => subtask.id)} strategy={verticalListSortingStrategy}>
            <TaskDropSlot
              isActive={activePreviewSlotId === getTaskDropSlotId(laneId, task.id, 0)}
              isDragReady={showSubtaskSlots}
              isVisible={showSubtaskSlots}
              laneId={laneId}
              parentTaskId={task.id}
              position={0}
            />
            {displaySubtasks.map((subtask, subtaskIndex) => (
              <div key={subtask.id}>
                <TaskCard
                  activePreviewSlotId={activePreviewSlotId}
                  activeTagKey={activeTagKey}
                  displaySubtasks={[]}
                  dropPositionsByTaskId={dropPositionsByTaskId}
                  dropPosition={dropPositionsByTaskId.get(subtask.id) ?? null}
                  isBoardDragDisabled={isBoardDragDisabled}
                  isNestTarget={false}
                  nestTargetMode="zone"
                  isTaskDragging={isTaskDragging}
                  laneId={laneId}
                  onOpen={onOpen}
                  onTagSelect={onTagSelect}
                  pendingMoveTaskIds={pendingMoveTaskIds}
                  showNestTarget={false}
                  showSubtaskSlots={showSubtaskSlots}
                  subtasks={[]}
                  task={subtask}
                  taskIndex={subtaskIndex}
                />
                <TaskDropSlot
                  isActive={
                    activePreviewSlotId === getTaskDropSlotId(laneId, task.id, subtaskIndex + 1)
                  }
                  isDragReady={showSubtaskSlots}
                  isVisible={showSubtaskSlots}
                  laneId={laneId}
                  parentTaskId={task.id}
                  position={subtaskIndex + 1}
                />
              </div>
            ))}
          </SortableContext>
        </div>
      ) : null}
    </article>
  );
}

function LaneTaskTrashTarget({
  isDeletePending,
  isDropActive,
  isVisible,
  laneId,
  pendingTask,
  onCancel,
  onConfirm
}: {
  isDeletePending: boolean;
  isDropActive: boolean;
  isVisible: boolean;
  laneId: string;
  pendingTask: Task | null;
  onCancel: () => void;
  onConfirm: (taskId: string) => void;
}) {
  const confirmRef = useRef<HTMLDivElement | null>(null);

  useDismissableLayer(Boolean(pendingTask), confirmRef, () => {
    if (!isDeletePending) {
      onCancel();
    }
  });

  return (
    <div
      className={`lane-task-trash-shell${isVisible || pendingTask ? " is-active" : ""}`}
      ref={confirmRef}
    >
      <div
        className={`lane-header__task-trash${isVisible ? " is-visible" : ""}${isDropActive ? " is-active" : ""}${pendingTask ? " is-confirm-open" : ""}`}
        data-testid={`lane-task-trash-target-${laneId}`}
        role="presentation"
        title="Drop to delete"
      >
        <span aria-hidden="true" className="lane-header__task-trash-mark">
          <TrashIcon />
        </span>
      </div>
      <TaskTrashConfirmPopover
        className="lane-task-trash-popover"
        isDeletePending={isDeletePending}
        onCancel={onCancel}
        onConfirm={onConfirm}
        pendingTask={pendingTask}
      />
    </div>
  );
}

function TaskTrashConfirmPopover({
  className,
  isDeletePending,
  onCancel,
  onConfirm,
  pendingTask
}: {
  className: string;
  isDeletePending: boolean;
  onCancel: () => void;
  onConfirm: (taskId: string) => void;
  pendingTask: Task | null;
}) {
  if (!pendingTask) {
    return null;
  }

  function handleButtonPointerUp(
    event: ReactPointerEvent<HTMLButtonElement>,
    action: () => void
  ) {
    event.preventDefault();
    action();
  }

  function handleButtonClick(event: ReactMouseEvent<HTMLButtonElement>, action: () => void) {
    if (event.detail !== 0) {
      return;
    }

    action();
  }

  return (
    <div
      aria-label={`Delete task ${pendingTask.title}`}
      className={`task-delete-popover ${className}`}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      role="alertdialog"
    >
      <p>Delete {pendingTask.title}?</p>
      <div className="task-delete-popover__actions">
        <button
          className="text-button"
          disabled={isDeletePending}
          onClick={(event) => handleButtonClick(event, onCancel)}
          onPointerUp={(event) => handleButtonPointerUp(event, onCancel)}
          type="button"
        >
          Cancel
        </button>
        <button
          className="ghost-button danger-button"
          disabled={isDeletePending}
          onClick={(event) => handleButtonClick(event, () => onConfirm(pendingTask.id))}
          onPointerUp={(event) =>
            handleButtonPointerUp(event, () => onConfirm(pendingTask.id))
          }
          type="button"
        >
          {isDeletePending ? "Deleting..." : "Delete"}
        </button>
      </div>
    </div>
  );
}

function MobileTaskTrashDock({
  isDeletePending,
  isDragging,
  laneId,
  onCancel,
  onConfirm,
  pendingTask
}: {
  isDeletePending: boolean;
  isDragging: boolean;
  laneId: string;
  onCancel: () => void;
  onConfirm: (taskId: string) => void;
  pendingTask: Task | null;
}) {
  const confirmRef = useRef<HTMLDivElement | null>(null);
  const { isOver, setNodeRef } = useDroppable({
    id: getTaskTrashDropTargetId(laneId),
    data: {
      laneId,
      type: "trash"
    },
    disabled: !isDragging
  });
  const isVisible = isDragging || pendingTask !== null;
  const isDockActive = (isDragging && isOver) || pendingTask !== null;

  useDismissableLayer(Boolean(pendingTask), confirmRef, () => {
    if (!isDeletePending) {
      onCancel();
    }
  });

  return (
    <div
      className={`mobile-task-trash-shell${isVisible ? " is-visible" : ""}${isDockActive ? " is-active" : ""}${pendingTask ? " is-confirm-open" : ""}`}
      ref={confirmRef}
    >
      <div
        className={`mobile-task-trash-dock${isDragging ? " is-visible" : ""}${isDockActive ? " is-active" : ""}${pendingTask ? " is-confirm-open" : ""}`}
        data-testid="mobile-task-trash-target"
        ref={setNodeRef}
        role="presentation"
        title="Drop to delete"
      >
        <span aria-hidden="true" className="mobile-task-trash-dock__mark">
          <TrashIcon />
        </span>
        <span className="mobile-task-trash-dock__copy">
          <strong>Delete card</strong>
          <span>Drop here from anywhere</span>
        </span>
      </div>
      <TaskTrashConfirmPopover
        className="mobile-task-trash-popover"
        isDeletePending={isDeletePending}
        onCancel={onCancel}
        onConfirm={onConfirm}
        pendingTask={pendingTask}
      />
    </div>
  );
}

function MarkdownSourceIcon() {
  return (
    <svg aria-hidden="true" className="task-editor__tab-icon" viewBox="0 0 24 24">
      <path
        d="M4.75 6.75h14.5v10.5H4.75zm4.75 0-3.25 5.25 3.25 5.25m5-10.5 3.25 5.25-3.25 5.25"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function MarkdownPreviewIcon() {
  return (
    <svg aria-hidden="true" className="task-editor__tab-icon" viewBox="0 0 24 24">
      <path
        d="M2.75 12s3.5-5.75 9.25-5.75S21.25 12 21.25 12 17.75 17.75 12 17.75 2.75 12 2.75 12Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
      <circle cx="12" cy="12" fill="none" r="3" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function TaskTagEditor({
  availableTags,
  inputColor,
  inputValue,
  onInputColorChange,
  onInputValueChange,
  onSelectedTagsChange,
  selectedTags
}: {
  availableTags: TaskTag[];
  inputColor: TaskTagColor;
  inputValue: string;
  onInputColorChange: (color: TaskTagColor) => void;
  onInputValueChange: (value: string) => void;
  onSelectedTagsChange: (tags: TaskTag[]) => void;
  selectedTags: TaskTag[];
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [selectedColorTargetKey, setSelectedColorTargetKey] = useState<string | null>(null);
  const selectedTagKeys = useMemo(
    () => new Set(selectedTags.map((tag) => normalizeTagKey(tag.label))),
    [selectedTags]
  );
  const suggestionQuery = normalizeTagKey(inputValue);
  const selectedColorTarget =
    selectedColorTargetKey === null
      ? null
      : selectedTags.find((tag) => normalizeTagKey(tag.label) === selectedColorTargetKey) ?? null;
  const draftColorTargetLabel = parseTagInput(inputValue)[0] ?? null;
  const activeColorTarget =
    selectedColorTarget ??
    (draftColorTargetLabel ? { color: inputColor, label: draftColorTargetLabel } : null);
  const activePaletteColor = activeColorTarget?.color ?? inputColor;
  const shouldShowPalette = activeColorTarget !== null;
  const visibleSuggestions = useMemo(
    () =>
      availableTags.filter((tag) => {
        const key = normalizeTagKey(tag.label);
        if (selectedTagKeys.has(key)) {
          return false;
        }

        return suggestionQuery.length === 0 || key.includes(suggestionQuery);
      }),
    [availableTags, selectedTagKeys, suggestionQuery]
  );

  useEffect(() => {
    if (
      selectedColorTargetKey !== null &&
      !selectedTags.some((tag) => normalizeTagKey(tag.label) === selectedColorTargetKey)
    ) {
      setSelectedColorTargetKey(null);
    }
  }, [selectedColorTargetKey, selectedTags]);

  function commitInputValue() {
    const nextTags = mergeUniqueTags(selectedTags, inputValue, inputColor);

    if (nextTags !== selectedTags) {
      onSelectedTagsChange(nextTags);
    }

    if (inputValue.length > 0) {
      onInputValueChange("");
      onInputColorChange(getRandomTaskTagColor());
    }

    return nextTags;
  }

  function removeTag(tagToRemove: string) {
    onSelectedTagsChange(
      selectedTags.filter((tag) => normalizeTagKey(tag.label) !== normalizeTagKey(tagToRemove))
    );
    if (selectedColorTargetKey === normalizeTagKey(tagToRemove)) {
      setSelectedColorTargetKey(null);
    }
    inputRef.current?.focus();
  }

  function addSuggestedTag(tag: TaskTag) {
    onSelectedTagsChange(mergeUniqueTags(selectedTags, tag.label, tag.color));
    onInputValueChange("");
    setSelectedColorTargetKey(normalizeTagKey(tag.label));
    inputRef.current?.focus();
  }

  function updateTagColor(color: TaskTagColor) {
    if (selectedColorTargetKey === null) {
      onInputColorChange(color);
      return;
    }

    onSelectedTagsChange(
      selectedTags.map((tag) =>
        normalizeTagKey(tag.label) === selectedColorTargetKey ? { ...tag, color } : tag
      )
    );
  }

  return (
    <div className="field">
      <span className="field__label" id="task-tag-editor-label">
        Tags
      </span>
      <div
        aria-labelledby="task-tag-editor-label"
        className="task-tag-editor"
        onBlur={(event) => {
          const nextFocusedNode = event.relatedTarget as Node | null;
          if (nextFocusedNode && event.currentTarget.contains(nextFocusedNode)) {
            return;
          }

          commitInputValue();
        }}
        role="group"
      >
        <div
          className="task-tag-editor__input-shell"
          onClick={() => {
            setSelectedColorTargetKey(null);
            inputRef.current?.focus();
          }}
          role="presentation"
        >
          {selectedTags.map((tag) => (
            <span
              className={`task-tag-editor__chip${selectedColorTargetKey === normalizeTagKey(tag.label) ? " is-selected" : ""}`}
              key={tag.label}
              style={getTaskTagStyle(tag.color)}
            >
              <button
                aria-label={`Edit color for tag ${tag.label}`}
                aria-pressed={selectedColorTargetKey === normalizeTagKey(tag.label)}
                className="task-tag-editor__chip-main"
                onClick={(event) => {
                  event.stopPropagation();
                  setSelectedColorTargetKey(normalizeTagKey(tag.label));
                }}
                onMouseDown={(event) => event.preventDefault()}
                type="button"
              >
                <span aria-hidden="true" className="task-tag-editor__chip-swatch" />
                <span className="task-tag-editor__chip-label">{tag.label}</span>
              </button>
              <button
                aria-label={`Remove tag ${tag.label}`}
                className="task-tag-editor__chip-remove"
                onClick={(event) => {
                  event.stopPropagation();
                  removeTag(tag.label);
                }}
                onMouseDown={(event) => event.preventDefault()}
                type="button"
              >
                <CloseIcon />
              </button>
            </span>
          ))}
          <input
            aria-label="Task tags"
            className="task-tag-editor__input"
            maxLength={240}
            onChange={(event) => {
              const nextValue = event.target.value;
              if (selectedColorTargetKey !== null) {
                setSelectedColorTargetKey(null);
              }
              if (inputValue.trim().length === 0 && nextValue.trim().length > 0) {
                onInputColorChange(getRandomTaskTagColor());
              }
              onInputValueChange(nextValue);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                commitInputValue();
                return;
              }

              if (
                (event.key === "Backspace" || event.key === "Delete") &&
                inputValue.length === 0 &&
                selectedTags.length > 0
              ) {
                event.preventDefault();
                onSelectedTagsChange(selectedTags.slice(0, -1));
              }
            }}
            placeholder={selectedTags.length > 0 ? "Add another tag" : "Add a tag"}
            ref={inputRef}
            value={inputValue}
          />
        </div>
        {shouldShowPalette ? (
          <div className="task-tag-editor__palette-panel">
            <span className="task-tag-editor__palette-label">
              {`Color for ${activeColorTarget?.label ?? ""}`}
            </span>
            <div className="task-tag-editor__palette" role="list">
              {taskTagColorOptions.map((option) => (
                <button
                  aria-label={`Set ${activeColorTarget?.label ?? "tag"} color to ${option.label}`}
                  aria-pressed={activePaletteColor === option.value}
                  className={`task-tag-editor__swatch${activePaletteColor === option.value ? " is-active" : ""}`}
                  key={option.value}
                  onClick={() => updateTagColor(option.value)}
                  onMouseDown={(event) => event.preventDefault()}
                  style={getTaskTagStyle(option.value)}
                  type="button"
                >
                  <span aria-hidden="true" className="task-tag-editor__swatch-dot" />
                  <span className="task-tag-editor__swatch-name">{option.label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {visibleSuggestions.length > 0 ? (
          <div aria-label="Suggested tags" className="task-tag-editor__suggestions" role="list">
            {visibleSuggestions.map((tag) => (
              <button
                aria-label={`Add tag ${tag.label}`}
                className="task-tag-editor__suggestion"
                key={tag.label}
                onClick={() => addSuggestedTag(tag)}
                onMouseDown={(event) => event.preventDefault()}
                style={getTaskTagStyle(tag.color)}
                type="button"
              >
                {tag.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TaskEditorDialog({
  availableProjects,
  availableTags,
  currentLane,
  isMovePending,
  onClose,
  onMove,
  onPersist,
  task
}: {
  availableProjects: Project[];
  availableTags: TaskTag[];
  currentLane: BoardLane | null;
  isMovePending: boolean;
  onClose: () => void;
  onMove: (destinationProjectId: string) => Promise<Task>;
  onPersist: (input: { body: string; tags: TaskTag[]; title: string }) => Promise<Task>;
  task: Task;
}) {
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.body);
  const [selectedTags, setSelectedTags] = useState(() => cloneTaskTags(task.tags));
  const [tagInputColor, setTagInputColor] = useState<TaskTagColor>(() => getRandomTaskTagColor());
  const [tagInputValue, setTagInputValue] = useState("");
  const [activeView, setActiveView] = useState<TaskEditorView>("source");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMovePopoverOpen, setIsMovePopoverOpen] = useState(false);
  const [moveProjectQuery, setMoveProjectQuery] = useState("");
  const [persistedTask, setPersistedTask] = useState(task);
  const [destinationProjectId, setDestinationProjectId] = useState("");
  const [moveError, setMoveError] = useState<unknown>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [isSavePending, setIsSavePending] = useState(false);

  const autosaveTimeoutRef = useRef<number | null>(null);
  const closeRequestPendingRef = useRef(false);
  const isMountedRef = useRef(true);
  const pendingSaveRequestRef = useRef<TaskEditorSaveRequest | null>(null);
  const persistedDraftRef = useRef(toTaskEditorDraft(task));
  const requestCloseRef = useRef<() => void>(() => {});
  const saveLoopPromiseRef = useRef<Promise<void> | null>(null);
  const movePopoverRef = useRef<HTMLDivElement | null>(null);
  const moveProjectInputRef = useRef<HTMLInputElement | null>(null);

  const bodyRef = useRef(body);
  const persistedTaskRef = useRef(persistedTask);
  const selectedTagsRef = useRef(selectedTags);
  const tagInputColorRef = useRef(tagInputColor);
  const tagInputValueRef = useRef(tagInputValue);
  const titleRef = useRef(title);

  bodyRef.current = body;
  persistedTaskRef.current = persistedTask;
  selectedTagsRef.current = selectedTags;
  tagInputColorRef.current = tagInputColor;
  tagInputValueRef.current = tagInputValue;
  titleRef.current = title;

  const destinationProject =
    availableProjects.find((project) => project.id === destinationProjectId) ?? null;
  const destinationLanePreview =
    destinationProject !== null
      ? resolveDestinationLanePreview(destinationProject, currentLane?.name ?? null)
      : null;
  const destinationLaneName = destinationLanePreview?.lane.name ?? "Select a board first";
  const noDestinationCopy = "Create another board to move this card.";
  const normalizedMoveProjectQuery = moveProjectQuery.trim().toLowerCase();
  const filteredMoveProjects = useMemo(
    () =>
      availableProjects.filter((project) => {
        if (!normalizedMoveProjectQuery) {
          return true;
        }

        return `${project.name} ${project.ticketPrefix}`
          .toLowerCase()
          .includes(normalizedMoveProjectQuery);
      }),
    [availableProjects, normalizedMoveProjectQuery]
  );
  const visibleMoveProjects = normalizedMoveProjectQuery
    ? filteredMoveProjects
    : filteredMoveProjects.slice(0, 5);

  useDismissableLayer(isMovePopoverOpen, movePopoverRef, () => {
    if (!isMovePending) {
      setIsMovePopoverOpen(false);
    }
  });

  function selectDestinationProject(project: Project) {
    setMoveError(null);
    setDestinationProjectId(project.id);
    setMoveProjectQuery(project.name);
  }

  function clearAutosaveTimer() {
    if (autosaveTimeoutRef.current !== null) {
      window.clearTimeout(autosaveTimeoutRef.current);
      autosaveTimeoutRef.current = null;
    }
  }

  function commitTransientTagDraft() {
    const nextTags = mergeUniqueTags(selectedTagsRef.current, tagInputValueRef.current, tagInputColorRef.current);

    if (nextTags !== selectedTagsRef.current) {
      setSelectedTags(nextTags);
    }

    if (tagInputValueRef.current.length > 0) {
      setTagInputValue("");
      setTagInputColor(getRandomTaskTagColor());
    }

    return {
      body: bodyRef.current,
      tags: cloneTaskTags(nextTags),
      title: titleRef.current.trim()
    };
  }

  function scheduleAutosave(draft: TaskEditorDraft) {
    clearAutosaveTimer();

    if (
      draft.title.length === 0 ||
      (!saveLoopPromiseRef.current && areTaskEditorDraftsEqual(draft, persistedDraftRef.current))
    ) {
      return;
    }

    autosaveTimeoutRef.current = window.setTimeout(() => {
      void enqueueSave(draft);
    }, 800);
  }

  async function runSaveLoop() {
    while (pendingSaveRequestRef.current) {
      const request = pendingSaveRequestRef.current;
      pendingSaveRequestRef.current = null;

      if (areTaskEditorDraftsEqual(request.draft, persistedDraftRef.current)) {
        request.waiters.forEach((waiter) => waiter.resolve(persistedTaskRef.current));
        continue;
      }

      if (!isMountedRef.current) {
        const error = new Error("Task editor closed.");
        request.waiters.forEach((waiter) => waiter.reject(error));
        break;
      }

      setSaveError(null);
      setIsSavePending(true);

      try {
        const updatedTask = await onPersist(request.draft);
        if (!isMountedRef.current) {
          return;
        }

        persistedDraftRef.current = toTaskEditorDraft(updatedTask);
        persistedTaskRef.current = updatedTask;
        setPersistedTask(updatedTask);
        request.waiters.forEach((waiter) => waiter.resolve(updatedTask));
      } catch (error) {
        if (!isMountedRef.current) {
          return;
        }

        setSaveError(error);
        request.waiters.forEach((waiter) => waiter.reject(error));

        const pendingRequest = pendingSaveRequestRef.current as TaskEditorSaveRequest | null;
        if (pendingRequest) {
          pendingRequest.waiters.forEach((waiter) => waiter.reject(error));
          pendingSaveRequestRef.current = null;
        }
      }
    }

    saveLoopPromiseRef.current = null;
    if (isMountedRef.current) {
      setIsSavePending(false);
    }
  }

  function enqueueSave(draft: TaskEditorDraft, options?: { waitForResult?: boolean }) {
    clearAutosaveTimer();

    if (draft.title.length === 0) {
      const error = new Error("Task title is required to save changes.");
      setSaveError(error);
      return options?.waitForResult ? Promise.reject(error) : Promise.resolve(persistedTaskRef.current);
    }

    if (!saveLoopPromiseRef.current && areTaskEditorDraftsEqual(draft, persistedDraftRef.current)) {
      if (isMountedRef.current) {
        setSaveError(null);
      }

      return Promise.resolve(persistedTaskRef.current);
    }

    const waiter =
      options?.waitForResult
        ? (() => {
            let resolve!: (task: Task) => void;
            let reject!: (error: unknown) => void;
            const promise = new Promise<Task>((promiseResolve, promiseReject) => {
              resolve = promiseResolve;
              reject = promiseReject;
            });

            return {
              promise,
              reject,
              resolve
            };
          })()
        : null;

    if (pendingSaveRequestRef.current) {
      pendingSaveRequestRef.current.draft = draft;
      if (waiter) {
        pendingSaveRequestRef.current.waiters.push({
          reject: waiter.reject,
          resolve: waiter.resolve
        });
      }
    } else {
      pendingSaveRequestRef.current = {
        draft,
        waiters:
          waiter === null
            ? []
            : [
                {
                  reject: waiter.reject,
                  resolve: waiter.resolve
                }
              ]
      };
    }

    if (!saveLoopPromiseRef.current) {
      saveLoopPromiseRef.current = runSaveLoop();
    }

    return waiter?.promise ?? Promise.resolve(persistedTaskRef.current);
  }

  async function handleManualSave() {
    const nextDraft = commitTransientTagDraft();

    try {
      await enqueueSave(nextDraft, { waitForResult: true });
    } catch {
      return;
    }
  }

  async function handleMove() {
    if (!destinationProject || !destinationLanePreview) {
      return;
    }

    setMoveError(null);
    const nextDraft = commitTransientTagDraft();

    try {
      await enqueueSave(nextDraft, { waitForResult: true });
    } catch {
      return;
    }

    try {
      const movedTask = await onMove(destinationProject.id);
      if (!isMountedRef.current) {
        return;
      }

      persistedDraftRef.current = toTaskEditorDraft(movedTask);
      persistedTaskRef.current = movedTask;
      setPersistedTask(movedTask);
      setIsMovePopoverOpen(false);
      setMoveProjectQuery("");
      setDestinationProjectId("");
      setSaveError(null);
    } catch (error) {
      if (!isMountedRef.current) {
        return;
      }

      setMoveError(error);
    }
  }

  async function requestClose() {
    const committedDraft = {
      body,
      tags: cloneTaskTags(selectedTags),
      title: title.trim()
    };
    const hasTransientDraft = mergeUniqueTags(selectedTags, tagInputValue, tagInputColor) !== selectedTags;

    if (
      !saveLoopPromiseRef.current &&
      !hasTransientDraft &&
      areTaskEditorDraftsEqual(committedDraft, persistedDraftRef.current)
    ) {
      setSaveError(null);
      onClose();
      return;
    }

    if (closeRequestPendingRef.current) {
      return;
    }

    closeRequestPendingRef.current = true;

    try {
      const nextDraft = commitTransientTagDraft();

      try {
        await enqueueSave(nextDraft, { waitForResult: true });
      } catch {
        return;
      }

      if (!isMountedRef.current) {
        return;
      }

      onClose();
    } finally {
      closeRequestPendingRef.current = false;
    }
  }

  requestCloseRef.current = () => {
    void requestClose();
  };

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      if (isMovePopoverOpen) {
        return;
      }

      event.preventDefault();
      requestCloseRef.current();
    }

    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isMovePopoverOpen]);

  useEffect(() => {
    if (!isMovePopoverOpen) {
      return;
    }

    moveProjectInputRef.current?.focus();
  }, [isMovePopoverOpen]);

  useEffect(() => {
    if (moveError === null) {
      return;
    }

    setMoveError(null);
  }, [destinationProjectId]);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      clearAutosaveTimer();

      const pendingRequest = pendingSaveRequestRef.current as TaskEditorSaveRequest | null;
      if (pendingRequest) {
        const error = new Error("Task editor closed.");
        pendingRequest.waiters.forEach((waiter) => waiter.reject(error));
        pendingSaveRequestRef.current = null;
      }
    };
  }, []);

  return (
    <div
      className={`dialog-scrim dialog-scrim--task-editor${isFullscreen ? " is-fullscreen" : ""}`}
      onClick={() => requestCloseRef.current()}
    >
      <section
        aria-labelledby="edit-task-title"
        aria-modal="true"
        className={`dialog-panel dialog-panel--task-editor${isFullscreen ? " is-fullscreen" : ""}`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="dialog-header">
          <h2 id="edit-task-title">{`Edit ${persistedTask.ticketId}`}</h2>
          <div className="dialog-header__actions">
            <button
              aria-label={isFullscreen ? "Exit full screen" : "Enter full screen"}
              aria-pressed={isFullscreen}
              className="icon-button"
              onClick={() => setIsFullscreen((current) => !current)}
              type="button"
            >
              {isFullscreen ? <ContractIcon /> : <ExpandIcon />}
            </button>
            <button
              aria-label="Close edit task dialog"
              className="icon-button"
              onClick={() => requestCloseRef.current()}
              type="button"
            >
              <CloseIcon />
            </button>
          </div>
        </div>
        <form
          className="dialog-form task-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void handleManualSave();
          }}
        >
          <div className="task-editor__grid">
            <label className="field">
              <span className="field__label">Title</span>
              <input
                autoFocus
                maxLength={240}
                onChange={(event) => {
                  setMoveError(null);
                  setSaveError(null);
                  setTitle(event.target.value);
                  scheduleAutosave({
                    body: bodyRef.current,
                    tags: cloneTaskTags(selectedTagsRef.current),
                    title: event.target.value.trim()
                  });
                }}
                placeholder="Task title"
                required
                value={title}
              />
            </label>
            <TaskTagEditor
              availableTags={availableTags}
              inputColor={tagInputColor}
              inputValue={tagInputValue}
              onInputColorChange={(color) => {
                setMoveError(null);
                setSaveError(null);
                setTagInputColor(color);
              }}
              onInputValueChange={(value) => {
                setMoveError(null);
                setSaveError(null);
                setTagInputValue(value);
              }}
              onSelectedTagsChange={(tags) => {
                setMoveError(null);
                setSaveError(null);
                setSelectedTags(tags);
                scheduleAutosave({
                  body: bodyRef.current,
                  tags: cloneTaskTags(tags),
                  title: titleRef.current.trim()
                });
              }}
              selectedTags={selectedTags}
            />
            <div className="field field--editor">
              <div className="task-editor__field-header">
                <span className="field__label task-editor__field-label">Body</span>
                <div
                  aria-label="Markdown editor view"
                  className="task-editor__view-tabs"
                  role="tablist"
                >
                  <button
                    aria-controls="task-markdown-source-panel"
                    aria-label="Markdown source"
                    aria-selected={activeView === "source"}
                    className={`task-editor__view-tab${activeView === "source" ? " is-active" : ""}`}
                    id="task-markdown-source-tab"
                    onClick={() => setActiveView("source")}
                    role="tab"
                    type="button"
                  >
                    <MarkdownSourceIcon />
                  </button>
                  <button
                    aria-controls="task-markdown-preview-panel"
                    aria-label="Rendered preview"
                    aria-selected={activeView === "preview"}
                    className={`task-editor__view-tab${activeView === "preview" ? " is-active" : ""}`}
                    id="task-markdown-preview-tab"
                    onClick={() => setActiveView("preview")}
                    role="tab"
                    type="button"
                  >
                    <MarkdownPreviewIcon />
                  </button>
                </div>
              </div>
              {activeView === "source" ? (
                <div
                  aria-labelledby="task-markdown-source-tab"
                  className="task-editor__panel"
                  id="task-markdown-source-panel"
                  role="tabpanel"
                >
                  <textarea
                    aria-label="Task body"
                    maxLength={12000}
                    onChange={(event) => {
                      setMoveError(null);
                      setSaveError(null);
                      setBody(event.target.value);
                      scheduleAutosave({
                        body: event.target.value,
                        tags: cloneTaskTags(selectedTagsRef.current),
                        title: titleRef.current.trim()
                      });
                    }}
                    placeholder="Write markdown here"
                    rows={12}
                    value={body}
                  />
                </div>
              ) : null}
              {activeView === "preview" ? (
                <div
                  aria-labelledby="task-markdown-preview-tab"
                  className="task-editor__preview-inline"
                  id="task-markdown-preview-panel"
                  role="tabpanel"
                >
                  <div
                    className="markdown-preview"
                    data-testid="task-markdown-preview"
                    id="task-markdown-preview"
                  >
                    {body.trim() ? (
                      <ReactMarkdown>{body}</ReactMarkdown>
                    ) : (
                      <p className="markdown-preview__empty">Nothing to preview yet.</p>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          {saveError ? <ErrorBanner error={saveError} /> : null}
          <div className="task-editor__footer">
            <dl aria-label="Card timing" className="task-editor__meta task-editor__meta--footer">
              <div className="task-editor__meta-item">
                <dt>Created</dt>
                <dd>
                  <time dateTime={persistedTask.createdAt}>{persistedTask.createdAt}</time>
                </dd>
              </div>
              <div className="task-editor__meta-item">
                <dt>Updated</dt>
                <dd>
                  <time dateTime={persistedTask.updatedAt}>{persistedTask.updatedAt}</time>
                </dd>
              </div>
            </dl>
            <div className="task-editor__footer-actions">
              <div className="dialog-actions task-editor__actions">
                <div className="task-editor__move-shell" ref={movePopoverRef}>
                  <button
                    aria-controls={isMovePopoverOpen ? "task-editor-move-popover" : undefined}
                    aria-expanded={isMovePopoverOpen}
                    aria-haspopup="dialog"
                    className="ghost-button task-editor__move-trigger"
                    data-testid="move-card-trigger"
                    disabled={isMovePending}
                    onClick={() => {
                      setMoveError(null);
                      setIsMovePopoverOpen((current) => {
                        const nextIsOpen = !current;
                        if (nextIsOpen) {
                          setMoveProjectQuery(destinationProject?.name ?? "");
                        }

                        return nextIsOpen;
                      });
                    }}
                    type="button"
                  >
                    Move
                  </button>
                  {isMovePopoverOpen ? (
                    <div
                      aria-label="Move card"
                      className="task-delete-popover task-editor__move-popover"
                      data-testid="move-card-popover"
                      id="task-editor-move-popover"
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                      role="group"
                    >
                      {availableProjects.length === 0 ? (
                        <>
                          <p className="field__hint task-editor__move-summary">{noDestinationCopy}</p>
                          <div className="task-delete-popover__actions">
                            <button
                              className="text-button"
                              onClick={() => setIsMovePopoverOpen(false)}
                              type="button"
                            >
                              Close
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <label className="field">
                            <span className="field__label">Destination board</span>
                            <input
                              aria-controls="move-card-project-results"
                              aria-expanded="true"
                              aria-label="Destination board"
                              disabled={isMovePending}
                              onChange={(event) => {
                                const nextValue = event.target.value;
                                setMoveError(null);
                                setMoveProjectQuery(nextValue);

                                if (
                                  !destinationProject ||
                                  nextValue.trim().toLowerCase() !== destinationProject.name.trim().toLowerCase()
                                ) {
                                  setDestinationProjectId("");
                                }
                              }}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter") {
                                  return;
                                }

                                event.preventDefault();
                                if (visibleMoveProjects.length === 1) {
                                  selectDestinationProject(visibleMoveProjects[0]);
                                }
                              }}
                              placeholder={
                                availableProjects.length > 5
                                  ? "Search boards"
                                  : "Type to search boards"
                              }
                              ref={moveProjectInputRef}
                              type="search"
                              value={moveProjectQuery}
                            />
                          </label>
                          <div
                            className="task-editor__move-project-list"
                            data-testid="move-card-project-list"
                            id="move-card-project-results"
                          >
                            {visibleMoveProjects.length > 0 ? (
                              visibleMoveProjects.map((project) => (
                                <button
                                  aria-pressed={project.id === destinationProjectId}
                                  className={`task-editor__move-project-option${project.id === destinationProjectId ? " is-active" : ""}`}
                                  data-testid={`move-card-project-option-${project.id}`}
                                  disabled={isMovePending}
                                  key={project.id}
                                  onClick={() => selectDestinationProject(project)}
                                  type="button"
                                >
                                  <span className="task-editor__move-project-copy">
                                    <span className="task-editor__move-project-name">{project.name}</span>
                                    <span className="task-editor__move-project-meta">{project.ticketPrefix}</span>
                                  </span>
                                </button>
                              ))
                            ) : (
                              <p className="task-editor__move-project-empty">No boards match that search.</p>
                            )}
                          </div>
                          {destinationProject && destinationLanePreview ? (
                            <div aria-live="polite" className="task-editor__move-preview">
                              <span className="task-editor__move-preview-label">Lane</span>
                              <span
                                aria-label="Destination lane"
                                className="task-editor__move-preview-value"
                                data-testid="move-card-lane-preview"
                              >
                                {destinationLaneName}
                              </span>
                            </div>
                          ) : null}
                          {moveError ? <ErrorBanner error={moveError} /> : null}
                          <div className="task-delete-popover__actions">
                            <button
                              className="text-button"
                              disabled={isMovePending}
                              onClick={() => setIsMovePopoverOpen(false)}
                              type="button"
                            >
                              Cancel
                            </button>
                            <button
                              className="ghost-button"
                              disabled={
                                destinationProject === null ||
                                destinationLanePreview === null ||
                                isMovePending ||
                                isSavePending
                              }
                              onClick={() => {
                                void handleMove();
                              }}
                              type="button"
                            >
                              {isMovePending ? "Moving card..." : "Move card"}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
                <button className="primary-button task-editor__close-button" onClick={() => requestCloseRef.current()} type="button">
                  Close
                </button>
                <button className="primary-button" disabled={isSavePending || title.trim().length === 0} type="submit">
                  Save card
                </button>
              </div>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}

export function BoardPage() {
  const location = useLocation();
  const { projectTicketPrefix, ticketId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const isMobileBoardLayout = useMediaQuery(mobileBoardBreakpointQuery);
  const locationToast = ((location.state as { toast?: BoardToast } | null) ?? null)?.toast ?? null;
  const [composerLaneId, setComposerLaneId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draggedLaneId, setDraggedLaneId] = useState<string | null>(null);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [laneDropTarget, setLaneDropTarget] = useState<{
    insertAfter: boolean;
    laneId: string;
    position: number;
  } | null>(null);
  const [taskDragPreview, setTaskDragPreview] = useState<TaskDragPreview | null>(null);
  const [laneName, setLaneName] = useState("");
  const [pendingDeleteTaskId, setPendingDeleteTaskId] = useState<string | null>(null);
  const [pendingDeleteTaskLaneId, setPendingDeleteTaskLaneId] = useState<string | null>(null);
  const [taskDragPreviewWidth, setTaskDragPreviewWidth] = useState<number | null>(null);
  const [toast, setToast] = useState<BoardToast | null>(locationToast);
  const laneDragPreviewRef = useRef<HTMLElement | null>(null);
  const pendingMoveNavigationTicketIdRef = useRef<string | null>(null);
  const pointerClientYRef = useRef<number | null>(null);
  const taskDragPreviewRef = useRef<TaskDragPreview | null>(null);
  const taskDragPreviewUpdatedAtRef = useRef<string | null>(null);

  const isValidProjectTicketPrefix =
    typeof projectTicketPrefix === "string" && projectTicketPrefixPattern.test(projectTicketPrefix);
  const projectQuery = useQuery({
    enabled: isValidProjectTicketPrefix,
    queryKey: ["project", projectTicketPrefix],
    queryFn: () => api.getProjectByTicketPrefix(projectTicketPrefix ?? "")
  });
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects()
  });
  const project = projectQuery.data ?? null;
  const resolvedProjectId = project?.id ?? null;
  const lanesQuery = useQuery({
    enabled: Boolean(resolvedProjectId),
    queryKey: ["lanes", resolvedProjectId],
    queryFn: () => api.listLanes(resolvedProjectId ?? "")
  });
  const tasksQuery = useQuery({
    enabled: Boolean(resolvedProjectId),
    queryKey: ["tasks", resolvedProjectId],
    queryFn: () => api.listTasks(resolvedProjectId ?? "")
  });
  const taskTagsQuery = useQuery({
    queryKey: ["task-tags"],
    queryFn: () => api.listTaskTags()
  });

  const isCreateLaneDialogOpen = searchParams.get("createLane") === "1";
  const boardSearch = searchParams.get("q")?.trim().toLowerCase() ?? "";
  const activeTagFilter = parseSingleTagInput(searchParams.get("tags") ?? "");
  const activeTagKey = activeTagFilter ? normalizeTagKey(activeTagFilter) : null;
  const lanes = lanesQuery.data ?? project?.laneSummaries ?? [];
  const lanesById = useMemo(() => new Map(lanes.map((lane) => [lane.id, lane])), [lanes]);
  const laneNameById = useMemo(() => new Map(lanes.map((lane) => [lane.id, lane.name])), [lanes]);
  const committedTasks = tasksQuery.data ?? [];
  const taskMoveMutationKey = ["task-move", resolvedProjectId] as const;
  const pendingTaskMovesState = useMutationState<PendingTaskMove | null>({
    filters: {
      mutationKey: taskMoveMutationKey,
      status: "pending"
    },
    select: (mutation) => {
      const variables = mutation.state.variables as TaskMoveMutationVariables | undefined;
      if (!variables) {
        return null;
      }

      return {
        ...variables,
        submittedAt: mutation.state.submittedAt
      };
    }
  });
  const pendingTaskMoves = useMemo(
    () => pendingTaskMovesState.filter((pendingMove): pendingMove is PendingTaskMove => pendingMove !== null),
    [pendingTaskMovesState]
  );
  const tasks = useMemo(
    () => applyPendingTaskMoves(committedTasks, pendingTaskMoves, lanesById),
    [committedTasks, lanesById, pendingTaskMoves]
  );
  const isMissingBoard = !isValidProjectTicketPrefix || isApiError(projectQuery.error, 404);
  const isProjectLoading = isValidProjectTicketPrefix && projectQuery.isPending;
  const availableMoveProjects = (projectsQuery.data ?? []).filter(
    (candidateProject) => candidateProject.id !== resolvedProjectId
  );
  const draggedLane = draggedLaneId ? lanes.find((lane) => lane.id === draggedLaneId) ?? null : null;
  const editingTask = ticketId ? tasks.find((task) => task.ticketId === ticketId) ?? null : null;
  const isBoardFiltered = boardSearch.length > 0 || activeTagKey !== null;
  const committedTaskMap = useMemo(() => new Map(committedTasks.map((task) => [task.id, task])), [committedTasks]);
  const taskMap = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const draggedTask =
    draggedTaskId
      ? taskMap.get(draggedTaskId) ?? null
      : null;
  const isTaskDragging = draggedTaskId !== null;
  const draggedTaskCanBecomeSubtask =
    draggedTask !== null && canTaskBecomeSubtask(tasks, draggedTask);
  const pendingDeleteTask =
    pendingDeleteTaskId
      ? taskMap.get(pendingDeleteTaskId) ?? null
      : null;
  const activeTaskTrashLaneId =
    draggedTask?.laneId ?? pendingDeleteTaskLaneId ?? null;
  const availableTaskTags = taskTagsQuery.data ?? listSuggestedTags(tasks);
  const pendingMoveTaskIds = useMemo(() => {
    const nextPendingTaskIds = new Set<string>();
    pendingTaskMoves.forEach((pendingMove) => {
      pendingMove.affectedTaskIds.forEach((taskId) => {
        nextPendingTaskIds.add(taskId);
      });
    });
    return nextPendingTaskIds;
  }, [pendingTaskMoves]);
  const topLevelTaskIdsByLane = useMemo(
    () => buildTopLevelTaskIdsByLane(lanes, tasks),
    [lanes, tasks]
  );
  const subtaskIdsByParent = useMemo(
    () => buildSubtaskIdsByParent(tasks, lanesById),
    [lanesById, tasks]
  );
  const taskSensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: taskMouseActivationDistance
      }
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: taskTouchActivationDelayMs,
        tolerance: taskTouchActivationTolerance
      }
    })
  );

  function taskMatchesBoardFilters(task: Task) {
    const haystack =
      `${task.ticketId}\n${task.title}\n${task.body}\n${task.tags.map((tag) => tag.label).join("\n")}`.toLowerCase();
    const matchesSearch = !boardSearch || haystack.includes(boardSearch);
    if (!matchesSearch) {
      return false;
    }

    if (activeTagKey === null) {
      return true;
    }

    const taskTagKeys = new Set(task.tags.map((tag) => normalizeTagKey(tag.label)));
    return taskTagKeys.has(activeTagKey);
  }

  const groupedTasks = lanes.map((lane) => ({
    ...lane,
    isDoneLane: isDoneLaneName(lane.name),
    isProtectedLane: isProtectedLaneName(lane.name),
    displayTasks: (topLevelTaskIdsByLane[lane.id] ?? [])
      .map((taskId) => taskMap.get(taskId))
      .filter((task): task is Task => Boolean(task))
      .map((task) => {
        const subtasks = (subtaskIdsByParent.get(task.id) ?? [])
          .map((subtaskId) => taskMap.get(subtaskId))
          .filter((subtask): subtask is Task => Boolean(subtask));
        const displaySubtasks = subtasks.filter((subtask) => taskMatchesBoardFilters(subtask));
        const shouldDisplay = !isBoardFiltered || taskMatchesBoardFilters(task) || displaySubtasks.length > 0;

        return {
          displaySubtasks,
          shouldDisplay,
          subtasks,
          task
        };
      })
      .filter((taskGroup) => taskGroup.shouldDisplay),
    tasks: (topLevelTaskIdsByLane[lane.id] ?? [])
      .map((taskId) => taskMap.get(taskId))
      .filter((task): task is Task => Boolean(task))
      .map((task) => ({
        displaySubtasks: (subtaskIdsByParent.get(task.id) ?? [])
          .map((subtaskId) => taskMap.get(subtaskId))
          .filter((subtask): subtask is Task => Boolean(subtask)),
        subtasks: (subtaskIdsByParent.get(task.id) ?? [])
          .map((subtaskId) => taskMap.get(subtaskId))
          .filter((subtask): subtask is Task => Boolean(subtask)),
      task
    }))
  }));
  const activeTaskDropSlotId = taskDragPreview?.slot.id ?? null;
  const dropPositionsByTaskId = useMemo(() => {
    const nextDropPositions = new Map<string, TaskCardDropPosition>();
    if (taskDragPreview?.targetTaskId && taskDragPreview.taskDropPosition) {
      nextDropPositions.set(taskDragPreview.targetTaskId, taskDragPreview.taskDropPosition);
    }

    return nextDropPositions;
  }, [taskDragPreview]);

  function taskDragPreviewEquals(left: TaskDragPreview | null, right: TaskDragPreview | null) {
    if (left === right) {
      return true;
    }

    if (!left || !right) {
      return false;
    }

    return (
      left.kind === right.kind &&
      left.moveTarget.laneId === right.moveTarget.laneId &&
      left.moveTarget.parentTaskId === right.moveTarget.parentTaskId &&
      left.moveTarget.position === right.moveTarget.position &&
      left.nestParentTaskId === right.nestParentTaskId &&
      left.slot.id === right.slot.id &&
      left.slot.interactive === right.slot.interactive &&
      left.targetTaskId === right.targetTaskId &&
      left.taskDropPosition === right.taskDropPosition
    );
  }

  function setTaskDragPreviewState(nextPreview: TaskDragPreview | null) {
    taskDragPreviewRef.current = nextPreview;
    setTaskDragPreview((currentPreview) =>
      taskDragPreviewEquals(currentPreview, nextPreview) ? currentPreview : nextPreview
    );
  }

  function toTaskDragOverData(event: DragOverEvent): TaskDragOverData | null {
    const overData = event.over?.data.current;
    if (!overData) {
      return null;
    }

    const translated = event.active.rect.current.translated;
    const activeHeight = event.active.rect.current.initial?.height ?? event.over?.rect.height ?? 0;
    const fallbackCenterY =
      translated !== null
        ? translated.top + activeHeight / 2
        : event.over
          ? event.over.rect.top + event.over.rect.height / 2
          : null;

    return {
      activeCenterY: pointerClientYRef.current ?? fallbackCenterY,
      laneId: typeof overData.laneId === "string" ? overData.laneId : null,
      parentTaskId: typeof overData.parentTaskId === "string" ? overData.parentTaskId : null,
      position: typeof overData.position === "number" ? overData.position : null,
      rectHeight: event.over?.rect.height ?? null,
      rectTop: event.over?.rect.top ?? null,
      taskId: typeof overData.taskId === "string" ? overData.taskId : null,
      type: overData.type as TaskDragOverData["type"]
    };
  }

  useEffect(() => {
    if (
      (pendingDeleteTaskId && !pendingDeleteTask) ||
      (pendingDeleteTaskLaneId && !lanesById.has(pendingDeleteTaskLaneId))
    ) {
      setPendingDeleteTaskId(null);
      setPendingDeleteTaskLaneId(null);
    }
  }, [lanesById, pendingDeleteTask, pendingDeleteTaskId, pendingDeleteTaskLaneId]);

  useEffect(() => {
    if (!draggedTaskId || committedTaskMap.has(draggedTaskId)) {
      return;
    }

    clearTaskDrag();
  }, [committedTaskMap, draggedTaskId]);

  async function invalidateBoardData(options?: {
    projectIds?: string[];
    projectTicketPrefixes?: string[];
  }) {
    const invalidations = [
      queryClient.invalidateQueries({ queryKey: ["task-tags"] }),
      queryClient.invalidateQueries({ queryKey: ["projects"] })
    ];

    const projectTicketPrefixes = new Set(options?.projectTicketPrefixes ?? []);
    const projectIds = new Set(options?.projectIds ?? []);

    if (projectTicketPrefix) {
      projectTicketPrefixes.add(projectTicketPrefix);
    }

    if (resolvedProjectId) {
      projectIds.add(resolvedProjectId);
    }

    projectTicketPrefixes.forEach((ticketPrefix) => {
      invalidations.push(queryClient.invalidateQueries({ queryKey: ["project", ticketPrefix] }));
    });
    projectIds.forEach((projectId) => {
      invalidations.push(
        queryClient.invalidateQueries({ queryKey: ["tasks", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["lanes", projectId] })
      );
    });

    await Promise.all(invalidations);
  }

  async function primeBoardData(nextProjectTicketPrefix: string, nextProjectId: string) {
    await Promise.all([
      queryClient.fetchQuery({
        queryKey: ["project", nextProjectTicketPrefix],
        queryFn: () => api.getProjectByTicketPrefix(nextProjectTicketPrefix)
      }),
      queryClient.fetchQuery({
        queryKey: ["lanes", nextProjectId],
        queryFn: () => api.listLanes(nextProjectId)
      }),
      queryClient.fetchQuery({
        queryKey: ["tasks", nextProjectId],
        queryFn: () => api.listTasks(nextProjectId)
      })
    ]);
  }

  const createLaneMutation = useMutation({
    mutationFn: (name: string) => api.createLane(resolvedProjectId ?? "", name),
    onSuccess: async () => {
      closeCreateLaneDialog();
      await invalidateBoardData();
    }
  });

  const createTaskMutation = useMutation({
    mutationFn: ({ laneId, title }: { laneId: string; title: string }) =>
      api.createTask(resolvedProjectId ?? "", {
        laneId,
        title
      }),
    onSuccess: async () => {
      setComposerLaneId(null);
      setDraftTitle("");
      updateBoardParams((params) => {
        params.delete("q");
        params.delete("tags");
      });
      await invalidateBoardData();
    }
  });

  const moveTaskMutation = useMutation({
    mutationKey: taskMoveMutationKey,
    mutationFn: ({
      laneId,
      parentTaskId,
      position,
      taskId
    }: TaskMoveMutationVariables) => api.updateTask(resolvedProjectId ?? "", taskId, { laneId, parentTaskId, position }),
    onSettled: async () => {
      await invalidateBoardData();
    }
  });
  const moveLaneMutation = useMutation({
    mutationFn: ({ laneId, position }: { laneId: string; position: number }) =>
      api.updateLane(resolvedProjectId ?? "", laneId, { position }),
    onSuccess: async () => {
      await invalidateBoardData();
    }
  });
  const deleteLaneMutation = useMutation({
    mutationFn: ({
      destinationLaneId,
      laneId
    }: {
      destinationLaneId?: string;
      laneId: string;
    }) =>
      api.deleteLane(
        resolvedProjectId ?? "",
        laneId,
        destinationLaneId ? { destinationLaneId } : undefined
      ),
    onSuccess: async (_, { destinationLaneId, laneId }) => {
      const deletedLane = lanes.find((lane) => lane.id === laneId) ?? null;
      const destinationLane =
        destinationLaneId
          ? lanes.find((lane) => lane.id === destinationLaneId) ?? null
          : null;
      const movedTaskCount = tasks.filter((task) => task.laneId === laneId).length;

      if (composerLaneId === laneId) {
        closeComposer();
      }
      if (draggedLaneId === laneId) {
        clearLaneDrag();
      }
      if (deletedLane) {
        const movedCardsCopy =
          destinationLane && movedTaskCount > 0
            ? ` Cards moved to ${destinationLane.name}.`
            : "";
        setToast({
          message: `${deletedLane.name} was deleted.${movedCardsCopy}`,
          title: "Lane deleted",
          tone: "success"
        });
      }
      await invalidateBoardData();
    }
  });

  const saveTaskMutation = useMutation({
    mutationFn: ({
      body,
      tags,
      taskId,
      title
    }: {
      body: string;
      tags: TaskTag[];
      taskId: string;
      title: string;
    }) => api.updateTask(resolvedProjectId ?? "", taskId, { body, tags, title }),
    onSuccess: (updatedTask) => {
      if (!resolvedProjectId) {
        return;
      }

      queryClient.setQueryData<Task[]>(["tasks", resolvedProjectId], (currentTasks) =>
        currentTasks ? mergeSavedTaskIntoTasks(currentTasks, updatedTask) : currentTasks
      );
      void queryClient.invalidateQueries({ queryKey: ["task-tags"] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    }
  });
  const moveTaskToProjectMutation = useMutation({
    mutationFn: ({
      destinationProjectId,
      taskId
    }: {
      destinationProjectId: string;
      taskId: string;
    }) => api.updateTask(resolvedProjectId ?? "", taskId, { destinationProjectId }),
    onSuccess: async (updatedTask, { taskId }) => {
      const previousTicketId =
        tasks.find((task) => task.id === taskId)?.ticketId ?? ticketId ?? updatedTask.ticketId;
      const destinationProjectTicketPrefix = updatedTask.ticketId.split("-")[0] ?? "";

      pendingMoveNavigationTicketIdRef.current = updatedTask.ticketId;
      await primeBoardData(destinationProjectTicketPrefix, updatedTask.projectId);

      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete("q");
      navigate(
        {
          pathname: buildBoardPath(destinationProjectTicketPrefix, updatedTask.ticketId),
          search: toSearchString(nextParams)
        },
        { replace: true }
      );
      setToast({
        message: `${previousTicketId} has been moved to ${updatedTask.ticketId}.`,
        title: "Card moved",
        tone: "success"
      });

      void invalidateBoardData({
        projectIds: [updatedTask.projectId],
        projectTicketPrefixes: [destinationProjectTicketPrefix]
      });
    }
  });

  const deleteTaskMutation = useMutation({
    mutationFn: (taskId: string) => api.deleteTask(resolvedProjectId ?? "", taskId),
    onSuccess: async (_, taskId) => {
      const deletedTask = tasks.find((task) => task.id === taskId) ?? null;
      const deletedTaskLaneId = deletedTask?.laneId ?? null;

      if (deletedTaskLaneId && resolvedProjectId) {
        queryClient.setQueryData<Task[]>(["tasks", resolvedProjectId], (currentTasks) =>
          currentTasks ? removeDeletedTaskFromTasks(currentTasks, taskId, laneNameById) : currentTasks
        );
        queryClient.setQueryData<BoardLane[]>(["lanes", resolvedProjectId], (currentLanes) =>
          currentLanes ? updateLaneTaskCounts(currentLanes, deletedTaskLaneId, -1) : currentLanes
        );
        queryClient.setQueryData<Project[]>(["projects"], (currentProjects) =>
          currentProjects
            ? currentProjects.map((currentProject) =>
                currentProject.id === resolvedProjectId
                  ? updateProjectLaneTaskCounts(currentProject, deletedTaskLaneId, -1)
                  : currentProject
              )
            : currentProjects
        );
        if (projectTicketPrefix) {
          queryClient.setQueryData<Project>(["project", projectTicketPrefix], (currentProject) =>
            currentProject
              ? updateProjectLaneTaskCounts(currentProject, deletedTaskLaneId, -1)
              : currentProject
          );
        }
      }

      setPendingDeleteTaskId(null);
      setPendingDeleteTaskLaneId(null);
      if (deletedTask) {
        setToast({
          message: `${deletedTask.title} (${deletedTask.ticketId}) was deleted.`,
          title: "Task deleted",
          tone: "success"
        });
      }
      await invalidateBoardData();
    }
  });
  const isTaskDragDisabled =
    isBoardFiltered ||
    deleteLaneMutation.isPending ||
    deleteTaskMutation.isPending ||
    moveLaneMutation.isPending ||
    pendingDeleteTaskId !== null ||
    saveTaskMutation.isPending ||
    draggedLaneId !== null;
  const isLaneDragDisabled =
    deleteLaneMutation.isPending ||
    deleteTaskMutation.isPending ||
    moveLaneMutation.isPending ||
    pendingDeleteTaskId !== null ||
    draggedTaskId !== null;

  function updateBoardParams(updater: (params: URLSearchParams) => void) {
    const nextParams = new URLSearchParams(searchParams);
    updater(nextParams);
    setSearchParams(nextParams, { replace: true });
  }

  function closeCreateLaneDialog() {
    updateBoardParams((params) => {
      params.delete("createLane");
    });
    setLaneName("");
    createLaneMutation.reset();
  }

  function openCreateLaneDialog() {
    updateBoardParams((params) => {
      params.set("createLane", "1");
    });
    setLaneName("");
    createLaneMutation.reset();
  }

  function openComposer(laneId: string) {
    setComposerLaneId(laneId);
    setDraftTitle("");
  }

  function closeComposer() {
    setComposerLaneId(null);
    setDraftTitle("");
  }

  function openTaskDialog(task: Task) {
    const boardPathPrefix = project?.ticketPrefix ?? projectTicketPrefix;
    if (!boardPathPrefix) {
      return;
    }

    navigate(
      {
        pathname: buildBoardPath(boardPathPrefix, task.ticketId),
        search: toSearchString(searchParams)
      },
      { replace: true }
    );
    saveTaskMutation.reset();
    moveTaskToProjectMutation.reset();
  }

  function closeTaskDialog() {
    const boardPathPrefix = project?.ticketPrefix ?? projectTicketPrefix;
    if (!boardPathPrefix) {
      return;
    }

    navigate(
      {
        pathname: buildBoardPath(boardPathPrefix),
        search: toSearchString(searchParams)
      },
      { replace: true }
    );
    saveTaskMutation.reset();
    moveTaskToProjectMutation.reset();
  }

  function updateTagFilter(tag: string | null) {
    updateBoardParams((params) => {
      const nextValue = formatSingleTagInput(tag);
      if (nextValue) {
        params.set("tags", nextValue);
      } else {
        params.delete("tags");
      }
    });
  }

  function handleTagSelect(tag: string) {
    if (activeTagKey === normalizeTagKey(tag)) {
      return;
    }

    updateTagFilter(tag);
  }

  function clearLaneDrag() {
    laneDragPreviewRef.current?.remove();
    laneDragPreviewRef.current = null;
    setDraggedLaneId(null);
    setLaneDropTarget(null);
  }

  function clearTaskDrag() {
    setDraggedTaskId(null);
    setTaskDragPreviewState(null);
    setTaskDragPreviewWidth(null);
    taskDragPreviewUpdatedAtRef.current = null;
  }

  function handleLaneDragStart(event: DragEvent<HTMLElement>, laneId: string) {
    if (isLaneDragDisabled) {
      event.preventDefault();
      return;
    }

    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", laneId);
    const column = event.currentTarget.closest(".board-column");
    if (column instanceof HTMLElement) {
      const preview = createNativeDragPreview(column);
      if (preview) {
        laneDragPreviewRef.current?.remove();
        laneDragPreviewRef.current = preview;
        const bounds = column.getBoundingClientRect();
        const offsetX = Math.max(0, Math.min(event.clientX - bounds.left, bounds.width));
        const offsetY = Math.max(0, Math.min(event.clientY - bounds.top, bounds.height));
        event.dataTransfer.setDragImage(preview, offsetX, offsetY);
      }
    }
    setDraggedLaneId(laneId);
    setLaneDropTarget(null);
  }

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      pointerClientYRef.current = event.clientY;
    }

    window.addEventListener("pointermove", handlePointerMove, { passive: true });

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
    };
  }, []);

  function resolveLanePosition(targetLaneId: string, insertAfter: boolean) {
    const visibleLaneIds = lanes
      .filter((lane) => lane.id !== draggedLaneId)
      .map((lane) => lane.id);
    const targetIndex = visibleLaneIds.indexOf(targetLaneId);
    if (targetIndex === -1) {
      return null;
    }

    return Math.max(0, Math.min(targetIndex + (insertAfter ? 1 : 0), visibleLaneIds.length));
  }

  function handleLaneDragOver(event: DragEvent<HTMLElement>, lane: BoardLane) {
    if (!draggedLaneId || isLaneDragDisabled || lane.id === draggedLaneId) {
      return;
    }

    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const insertAfter = event.clientX > bounds.left + bounds.width / 2;
    const position = resolveLanePosition(lane.id, insertAfter);
    if (position === null) {
      return;
    }

    setLaneDropTarget((current) => {
      if (
        current?.laneId === lane.id &&
        current.position === position &&
        current.insertAfter === insertAfter
      ) {
        return current;
      }

      return {
        laneId: lane.id,
        position,
        insertAfter
      };
    });
  }

  function handleLaneDrop() {
    const laneId = draggedLane?.id;
    const position = laneDropTarget?.position;

    clearLaneDrag();
    if (!laneId || position === undefined) {
      return;
    }

    moveLaneMutation.mutate({
      laneId,
      position
    });
  }

  function handleTaskDragStart(event: DragStartEvent) {
    if (isTaskDragDisabled) {
      return;
    }

    const activeTaskId = String(event.active.id);

    flushSync(() => {
      setPendingDeleteTaskId(null);
      setPendingDeleteTaskLaneId(null);
      setDraggedTaskId(activeTaskId);
      setTaskDragPreviewWidth(event.active.rect.current.initial?.width ?? null);
      setTaskDragPreviewState(null);
    });
    taskDragPreviewUpdatedAtRef.current = getTaskPreviewUpdatedAt(tasks);
  }

  function handleTaskDragOver(event: DragOverEvent) {
    if (!draggedTaskId || isTaskDragDisabled) {
      return;
    }

    if (!event.over) {
      setTaskDragPreviewState(null);
      return;
    }

    const nextPreview = resolveTaskDragPreview({
      activeTaskId: String(event.active.id),
      lanesById,
      overData: toTaskDragOverData(event),
      subtaskIdsByParent,
      tasks,
      topLevelTaskIdsByLane
    });

    setTaskDragPreviewState(nextPreview);
  }

  function handleTaskDragEnd(event: DragEndEvent) {
    const activeTaskId = String(event.active.id);
    if (event.over?.data.current?.type === "trash") {
      const dropTargetLaneId =
        typeof event.over.data.current?.laneId === "string"
          ? String(event.over.data.current.laneId)
          : getLaneIdFromTaskTrashDropTargetId(event.over.id);
      setPendingDeleteTaskId(activeTaskId);
      setPendingDeleteTaskLaneId(dropTargetLaneId);
      clearTaskDrag();
      return;
    }

    const source = findTaskLocation(tasks, activeTaskId);
    const destination = taskDragPreviewRef.current?.moveTarget ?? null;
    if (!source || !destination) {
      clearTaskDrag();
      return;
    }

    if (
      source.laneId === destination.laneId &&
      source.parentTaskId === destination.parentTaskId &&
      source.position === destination.position
    ) {
      clearTaskDrag();
      return;
    }

    moveTaskMutation.mutate({
      affectedTaskIds: getTaskMoveAffectedTaskIds(tasks, activeTaskId),
      laneId: destination.laneId,
      parentTaskId: destination.parentTaskId,
      position: destination.position,
      previewUpdatedAt: taskDragPreviewUpdatedAtRef.current,
      taskId: activeTaskId
    });
    clearTaskDrag();
  }

  useEffect(() => {
    if (!isCreateLaneDialogOpen) {
      return;
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      closeCreateLaneDialog();
    }

    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isCreateLaneDialogOpen]);

  useEffect(() => {
    return () => {
      laneDragPreviewRef.current?.remove();
      laneDragPreviewRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!locationToast) {
      return;
    }

    setToast(locationToast);
    navigate(
      {
        pathname: location.pathname,
        search: location.search
      },
      { replace: true, state: null }
    );
  }, [location.pathname, location.search, locationToast, navigate]);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setToast(null);
    }, 4000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [toast]);

  useEffect(() => {
    if (ticketId && pendingMoveNavigationTicketIdRef.current === ticketId) {
      pendingMoveNavigationTicketIdRef.current = null;
    }
  }, [ticketId]);

  useEffect(() => {
    if (
      !ticketId ||
      editingTask ||
      isProjectLoading ||
      pendingMoveNavigationTicketIdRef.current !== null ||
      tasksQuery.isPending ||
      tasksQuery.error ||
      !resolvedProjectId ||
      !project
    ) {
      return;
    }

    setToast({
      message: `Ticket ${ticketId} does not exist.`,
      title: "Ticket not found",
      tone: "danger"
    });
    navigate(
      {
        pathname: buildBoardPath(project.ticketPrefix),
        search: toSearchString(searchParams)
      },
      { replace: true }
    );
  }, [
    editingTask,
    isProjectLoading,
    navigate,
    project,
    resolvedProjectId,
    searchParams,
    tasksQuery.error,
    tasksQuery.isPending,
    ticketId
  ]);

  if (!projectTicketPrefix) {
    return <Navigate replace to="/" />;
  }

  if (isMissingBoard) {
    return (
      <Navigate
        replace
        state={{
          toast: {
            message: `Board ${projectTicketPrefix} does not exist.`,
            title: "Board not found",
            tone: "danger"
          }
        }}
        to="/"
      />
    );
  }

  return (
    <main className={`page-shell page-shell--board${isTaskDragging ? " is-task-dragging" : ""}`}>
      <title>{project ? `${project.name} | BBTodo` : "Board | BBTodo"}</title>
      {toast ? (
        <ToastNotice
          message={toast.message}
          onDismiss={() => setToast(null)}
          title={toast.title}
          tone={toast.tone}
        />
      ) : null}
      {isCreateLaneDialogOpen ? (
        <div className="dialog-scrim" onClick={() => closeCreateLaneDialog()}>
          <section
            aria-labelledby="create-lane-title"
            aria-modal="true"
            className="dialog-panel"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="dialog-header">
              <h2 id="create-lane-title">Create Lane</h2>
              <button
                aria-label="Close create lane dialog"
                className="icon-button"
                onClick={() => closeCreateLaneDialog()}
                type="button"
              >
                <CloseIcon />
              </button>
            </div>
            <form
              className="dialog-form"
              onSubmit={(event) => {
                event.preventDefault();
                createLaneMutation.mutate(laneName.trim());
              }}
            >
              <label className="field">
                <input
                  aria-label="Lane name"
                  autoFocus
                  maxLength={80}
                  onChange={(event) => setLaneName(event.target.value)}
                  placeholder="Ready for QA"
                  required
                  value={laneName}
                />
              </label>
              {createLaneMutation.error ? <ErrorBanner error={createLaneMutation.error} /> : null}
              <div className="dialog-actions">
                <button className="text-button" onClick={() => closeCreateLaneDialog()} type="button">
                  Cancel
                </button>
                <button
                  className="primary-button"
                  disabled={createLaneMutation.isPending || laneName.trim().length === 0}
                  type="submit"
                >
                  {createLaneMutation.isPending ? "Creating lane..." : "Create Lane"}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {editingTask ? (
        <TaskEditorDialog
          key={editingTask.ticketId}
          availableProjects={availableMoveProjects}
          availableTags={availableTaskTags}
          currentLane={editingTask.laneId ? lanesById.get(editingTask.laneId) ?? null : null}
          isMovePending={moveTaskToProjectMutation.isPending}
          onClose={closeTaskDialog}
          onMove={(destinationProjectId) =>
            moveTaskToProjectMutation.mutateAsync({
              destinationProjectId,
              taskId: editingTask.id
            })
          }
          onPersist={({ body, tags, title }) =>
            saveTaskMutation.mutateAsync({
              body,
              tags,
              taskId: editingTask.id,
              title
            })
          }
          task={editingTask}
        />
      ) : null}

      {projectQuery.error && !isApiError(projectQuery.error, 404) ? <ErrorBanner error={projectQuery.error} /> : null}
      {projectsQuery.error ? <ErrorBanner error={projectsQuery.error} /> : null}
      {lanesQuery.error ? <ErrorBanner error={lanesQuery.error} /> : null}
      {tasksQuery.error ? <ErrorBanner error={tasksQuery.error} /> : null}
      {createTaskMutation.error ? <ErrorBanner error={createTaskMutation.error} /> : null}
      {moveTaskMutation.error ? <ErrorBanner error={moveTaskMutation.error} /> : null}
      {moveTaskToProjectMutation.error ? <ErrorBanner error={moveTaskToProjectMutation.error} /> : null}
      {moveLaneMutation.error ? <ErrorBanner error={moveLaneMutation.error} /> : null}
      {deleteLaneMutation.error ? <ErrorBanner error={deleteLaneMutation.error} /> : null}
      {deleteTaskMutation.error ? <ErrorBanner error={deleteTaskMutation.error} /> : null}

      {isProjectLoading || (project !== null && (lanesQuery.isPending || tasksQuery.isPending)) ? (
        <BoardSkeleton />
      ) : null}

      {!isProjectLoading && !lanesQuery.isPending && !tasksQuery.isPending && project ? (
        <DndContext
          collisionDetection={taskCollisionDetection}
          measuring={taskMeasuring}
          onDragCancel={clearTaskDrag}
          onDragEnd={handleTaskDragEnd}
          onDragOver={handleTaskDragOver}
          onDragStart={handleTaskDragStart}
          sensors={taskSensors}
        >
          <section className="board-grid board-grid--lanes" data-testid="board-grid">
            {groupedTasks.map((lane, laneIndex) => {
              const nextLane = groupedTasks[laneIndex + 1] ?? null;
              const gapLabel = nextLane
                ? `Create lane between ${lane.name} and ${nextLane.name}`
                : `Create lane after ${lane.name}`;
              const showRootTaskSlots = Boolean(draggedTaskId) && !lane.isDoneLane;
              const showSubtaskSlots = showRootTaskSlots && !draggedTaskCanBecomeSubtask;
              const showDoneTopPreviewSlot =
                lane.isDoneLane &&
                taskDragPreview?.slot.laneId === lane.id &&
                taskDragPreview.slot.parentTaskId === null &&
                taskDragPreview.slot.position === 0;

              return (
                <div className="board-column-shell" key={lane.id}>
                  <div
                    className={`board-column${taskDragPreview?.moveTarget.laneId === lane.id ? " is-drop-target" : ""}${draggedLaneId === lane.id ? " is-lane-dragging" : ""}${laneDropTarget?.laneId === lane.id ? " is-lane-drop-target" : ""}${laneDropTarget?.laneId === lane.id && laneDropTarget.insertAfter ? " is-lane-drop-after" : ""}${laneDropTarget?.laneId === lane.id && !laneDropTarget.insertAfter ? " is-lane-drop-before" : ""}`}
                    data-testid={`board-column-${lane.id}`}
                    onDoubleClick={(event) => {
                      const target = event.target as HTMLElement;
                      if (target.closest("button, input, select, textarea, form, a")) {
                        return;
                      }

                      openComposer(lane.id);
                    }}
                    onDragLeave={(event) => {
                      if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) {
                        setLaneDropTarget((current) => (current?.laneId === lane.id ? null : current));
                      }
                    }}
                    onDragOver={(event) => handleLaneDragOver(event, lane)}
                    onDrop={(event) => {
                      if (!draggedLaneId) {
                        return;
                      }

                      event.preventDefault();
                      event.stopPropagation();
                      handleLaneDrop();
                    }}
                    style={itemStyle(laneIndex)}
                  >
                    <LaneHeader
                      destinationLanes={lanes.filter((candidate) => candidate.id !== lane.id)}
                      isDeletePending={deleteLaneMutation.isPending}
                      isDragDisabled={isLaneDragDisabled}
                      isProtected={lane.isProtectedLane}
                      isTaskDeletePending={deleteTaskMutation.isPending}
                      isTaskDragging={isTaskDragging}
                      isTaskTrashVisible={draggedTask?.laneId === lane.id}
                      lane={lane}
                      onAddTask={() => openComposer(lane.id)}
                      onCancelTaskDelete={() => {
                        setPendingDeleteTaskId(null);
                        setPendingDeleteTaskLaneId(null);
                      }}
                      onDelete={(destinationLaneId) =>
                        deleteLaneMutation.mutate({
                          laneId: lane.id,
                          destinationLaneId
                        })
                      }
                      onConfirmTaskDelete={(taskId) => deleteTaskMutation.mutate(taskId)}
                      onDragEnd={() => clearLaneDrag()}
                      onDragStart={handleLaneDragStart}
                      pendingTaskDelete={pendingDeleteTaskLaneId === lane.id ? pendingDeleteTask : null}
                      useFloatingTaskTrash={isMobileBoardLayout && activeTaskTrashLaneId === lane.id}
                    />
                    <LaneDropArea laneId={lane.id}>
                      <SortableContext
                        items={lane.tasks.map((taskGroup) => taskGroup.task.id)}
                        strategy={verticalListSortingStrategy}
                      >
                        {composerLaneId === lane.id ? (
                          <form
                            className="lane-composer"
                            data-testid={`lane-composer-${lane.id}`}
                            onClick={(event) => event.stopPropagation()}
                            onDoubleClick={(event) => event.stopPropagation()}
                            onPointerDown={(event) => event.stopPropagation()}
                            onSubmit={(event) => {
                              event.preventDefault();
                              createTaskMutation.mutate({
                                laneId: lane.id,
                                title: draftTitle.trim()
                              });
                            }}
                          >
                            <label className="field">
                              <input
                                aria-label={getTaskInputLabel(lane.name)}
                                autoFocus
                                maxLength={240}
                                onChange={(event) => setDraftTitle(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Escape") {
                                    closeComposer();
                                  }
                                }}
                                placeholder={`Add to ${lane.name}`}
                                required
                                value={draftTitle}
                              />
                            </label>
                            <div className="lane-composer__actions">
                              <button
                                className="primary-button"
                                disabled={createTaskMutation.isPending || draftTitle.trim().length === 0}
                                type="submit"
                              >
                                {createTaskMutation.isPending ? "Adding..." : "Add task"}
                              </button>
                              <button className="text-button" onClick={() => closeComposer()} type="button">
                                Cancel
                              </button>
                            </div>
                          </form>
                        ) : null}
                        <TaskDropSlot
                          isActive={activeTaskDropSlotId === getTaskDropSlotId(lane.id, null, 0)}
                          isDragReady={showRootTaskSlots}
                          isInteractive={!lane.isDoneLane}
                          isVisible={showRootTaskSlots || showDoneTopPreviewSlot}
                          laneId={lane.id}
                          parentTaskId={null}
                          position={0}
                        />
                        {lane.displayTasks.map((taskGroup, taskIndex) => (
                          <div key={taskGroup.task.id}>
                            <TaskCard
                              activePreviewSlotId={activeTaskDropSlotId}
                              activeTagKey={activeTagKey}
                              displaySubtasks={taskGroup.displaySubtasks}
                              dropPositionsByTaskId={dropPositionsByTaskId}
                              dropPosition={dropPositionsByTaskId.get(taskGroup.task.id) ?? null}
                              isBoardDragDisabled={isTaskDragDisabled}
                              isNestTarget={
                                taskDragPreview?.kind === "nest" &&
                                taskDragPreview.nestParentTaskId === taskGroup.task.id
                              }
                              nestTargetMode={draggedTaskCanBecomeSubtask ? "body" : "zone"}
                              isTaskDragging={draggedTaskId !== null}
                              laneId={lane.id}
                              onOpen={openTaskDialog}
                              onTagSelect={handleTagSelect}
                              pendingMoveTaskIds={pendingMoveTaskIds}
                              showNestTarget={
                                draggedTask !== null &&
                                !lane.isDoneLane &&
                                draggedTask.id !== taskGroup.task.id &&
                                canTaskNestUnderParent(tasks, draggedTask, taskGroup.task.id)
                              }
                              showSubtaskSlots={showSubtaskSlots}
                              subtasks={taskGroup.subtasks}
                              task={taskGroup.task}
                              taskIndex={taskIndex}
                            />
                            <TaskDropSlot
                              isActive={
                                activeTaskDropSlotId === getTaskDropSlotId(lane.id, null, taskIndex + 1)
                              }
                              isDragReady={showRootTaskSlots}
                              isVisible={showRootTaskSlots}
                              laneId={lane.id}
                              parentTaskId={null}
                              position={taskIndex + 1}
                            />
                          </div>
                        ))}
                      </SortableContext>
                    </LaneDropArea>
                  </div>
                  <button
                    aria-label={gapLabel}
                    className="board-lane-gap"
                    data-testid={`create-lane-gap-after-${lane.id}`}
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openCreateLaneDialog();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openCreateLaneDialog();
                      }
                    }}
                    title="Double-click to create a lane"
                    type="button"
                  >
                    <span aria-hidden="true" className="board-lane-gap__marker">
                      +
                    </span>
                  </button>
                  <button
                    aria-label={`Create lane after ${lane.name}`}
                    className="board-lane-gap-mobile"
                    data-testid={`create-lane-mobile-after-${lane.id}`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openCreateLaneDialog();
                    }}
                    type="button"
                  >
                    <PlusIcon className="board-lane-gap-mobile__icon" />
                  </button>
                </div>
              );
            })}
          </section>
          {isMobileBoardLayout && activeTaskTrashLaneId ? (
            <MobileTaskTrashDock
              isDeletePending={deleteTaskMutation.isPending}
              isDragging={isTaskDragging}
              laneId={activeTaskTrashLaneId}
              onCancel={() => {
                setPendingDeleteTaskId(null);
                setPendingDeleteTaskLaneId(null);
              }}
              onConfirm={(taskId) => deleteTaskMutation.mutate(taskId)}
              pendingTask={pendingDeleteTask}
            />
          ) : null}
          <DragOverlay dropAnimation={taskDropAnimation}>
            {draggedTask ? (
              <div
                className="task-drag-overlay"
                style={taskDragPreviewWidth ? { width: `${taskDragPreviewWidth}px` } : undefined}
              >
                <TaskCardPreview activeTagKey={activeTagKey} task={draggedTask} />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : null}
    </main>
  );
}
