import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { api, type Project } from "../api";

type CreateProjectMutationSuccessContext = {
  queryClient: QueryClient;
};

type CreateProjectMutationOptions = {
  onSuccess?: (
    project: Project,
    context: CreateProjectMutationSuccessContext
  ) => void | Promise<void>;
};

export function prependProjectToList(projects: Project[] | undefined, createdProject: Project) {
  return [createdProject, ...(projects ?? []).filter((project) => project.id !== createdProject.id)];
}

export function useCreateProjectMutation(options: CreateProjectMutationOptions = {}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (name: string) => api.createProject(name),
    onSuccess: async (project) => {
      queryClient.setQueriesData<Project[]>({ queryKey: ["projects"] }, (currentProjects) =>
        currentProjects ? prependProjectToList(currentProjects, project) : currentProjects
      );
      try {
        await options.onSuccess?.(project, { queryClient });
      } finally {
        void queryClient.invalidateQueries({ queryKey: ["projects"] });
      }
    }
  });
}
