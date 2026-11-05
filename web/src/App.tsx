import { useEffect } from "react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { api, isApiError } from "./api";
import { queryClient } from "./app/queryClient";
import { useHasUnsavedEdits } from "./app/unsavedEdits";
import { ErrorBanner, LoadingState } from "./components/ui";
import { AppShell } from "./layout/AppShell";
import { ApiTokensPage } from "./pages/ApiTokensPage";
import { BoardPage } from "./pages/BoardPage";
import { LoginPage } from "./pages/LoginPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { TodosPage } from "./pages/TodosPage";
import "./styles.css";

function AuthenticatedApp() {
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: () => api.getMe()
  });
  const hasUnsavedEdits = useHasUnsavedEdits();
  const resolvedTheme = meQuery.data?.theme ?? "sea";

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  if (meQuery.isPending) {
    return <LoadingState />;
  }

  // Replacing the app unmounts any open editor, so an expired session waits while edits are unsaved.
  if (isApiError(meQuery.error, 401) && !hasUnsavedEdits) {
    return <LoginPage />;
  }

  // A failed background refetch still has the last known user, so it must not take the app down.
  if (!meQuery.data) {
    return (
      <main className="centered-state">
        <title>BBTodo</title>
        <section className="hero-panel centered-panel">
          <p className="eyebrow">bbtodo</p>
          <h1>We hit a problem loading your workspace.</h1>
          <p className="lead-copy">The session may be stale or the server may still be starting up.</p>
          <ErrorBanner error={meQuery.error} />
        </section>
      </main>
    );
  }

  return (
    <Routes>
      <Route element={<AppShell user={meQuery.data} />}>
        <Route element={<ProjectsPage />} path="/" />
        <Route element={<TodosPage />} path="/todos" />
        <Route element={<BoardPage />} path="/projects/:projectTicketPrefix/:ticketId?" />
        <Route element={<ApiTokensPage />} path="/settings/api-tokens" />
        <Route element={<Navigate replace to="/" />} path="*" />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthenticatedApp />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
