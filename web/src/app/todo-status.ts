import { queryOptions } from "@tanstack/react-query";

import { api, type Project } from "../api";
import { defaultLaneLabels } from "./constants";

export function normalizeStatus(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function getTodoStatus(value: string | null) {
  const label = value?.trim().replace(/\s+/g, " ") || "Todo";
  const key = normalizeStatus(label);
  return {
    key,
    label: defaultLaneLabels.find((name) => normalizeStatus(name) === key) ?? label
  };
}

export function getStatusOptions(projects: Project[]) {
  // Keep the default view reachable even when there are no active boards.
  const labels = new Map<string, string>([["todo", "Todo"]]);
  projects.filter((project) => !project.archived).forEach((project) => {
    project.laneSummaries.forEach((lane) => {
      const { key, label } = getTodoStatus(lane.name);
      if (!labels.has(key)) {
        labels.set(key, label);
      }
    });
  });
  const standardKeys = defaultLaneLabels.map(normalizeStatus);
  return Array.from(labels, ([key, label]) => ({ key, label })).sort((left, right) => {
    const leftIndex = standardKeys.indexOf(left.key);
    const rightIndex = standardKeys.indexOf(right.key);
    if (leftIndex !== -1 || rightIndex !== -1) {
      return (leftIndex === -1 ? Infinity : leftIndex) - (rightIndex === -1 ? Infinity : rightIndex);
    }
    return left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
  });
}

export function todoQueryOptions(status: string) {
  const key = normalizeStatus(status);
  return queryOptions({
    queryKey: ["todos", key],
    queryFn: () => api.listTodoGroups(key)
  });
}
