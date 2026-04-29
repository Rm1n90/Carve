import React from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/fraunces";
import { rootRoute } from "./routes/_root";
import { indexRoute } from "./routes/index";
import { loginRoute } from "./routes/login";
import { registerRoute } from "./routes/register";
import { projectsRoute } from "./routes/projects";
import { projectDetailRoute } from "./routes/projects.$projectId";
import { projectStatsRoute } from "./routes/projects.$projectId.stats";
import { taskDetailRoute } from "./routes/projects.$projectId.tasks.$taskId";
import { annotateAssetRoute } from "./routes/projects.$projectId.tasks.$taskId.assets.$assetId";
import {
  modelsSamRoute,
  modelsYoloRoute,
  settingsApiKeysRoute,
  settingsIndexRoute,
  settingsMembersRoute,
  settingsProfileRoute,
  settingsWorkspaceRoute,
  trashRoute,
} from "./routes/phase2";
import { ThemeProvider } from "./components/theme/ThemeProvider";
import { ConfirmProvider } from "./components/ui/ConfirmDialog";
import "./styles/global.css";

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  registerRoute,
  projectsRoute,
  projectDetailRoute,
  projectStatsRoute,
  taskDetailRoute,
  annotateAssetRoute,
  settingsIndexRoute,
  settingsProfileRoute,
  settingsApiKeysRoute,
  settingsMembersRoute,
  settingsWorkspaceRoute,
  modelsYoloRoute,
  modelsSamRoute,
  trashRoute,
]);
const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000 } },
});

const el = document.getElementById("root");
if (!el) throw new Error("root element not found");
createRoot(el).render(
  <React.StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ConfirmProvider>
          <RouterProvider router={router} />
        </ConfirmProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
