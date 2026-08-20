// Armin Mehri — mehri.armin@gmail.com
import { Navigate, createRoute } from "@tanstack/react-router";
import { rootRoute } from "./_root";
import { RequireAuth } from "@/auth/RequireAuth";
import { RequireAdmin } from "@/auth/RequireAdmin";
import {
  SettingsApiKeysPage,
  SettingsMembersPage,
  SettingsProfilePage,
  SettingsWorkspacePage,
} from "@/pages/SettingsPages";
import { SettingsShortcutsPage } from "@/pages/SettingsShortcutsPage";
import { ModelsYoloPage, ModelsSamPage, TrashPage } from "@/pages/Phase2Pages";
import { AboutPage } from "@/pages/AboutPage";
import { SystemPage } from "@/pages/SystemPage";
import { JobsPage } from "@/pages/JobsPage";

// ---------------------------- Settings family ----------------------------

export const settingsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: () => (
    <RequireAuth>
      <Navigate to="/settings/profile" replace />
    </RequireAuth>
  ),
});

export const settingsProfileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/profile",
  component: () => (
    <RequireAuth>
      <SettingsProfilePage />
    </RequireAuth>
  ),
});

export const settingsApiKeysRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/api-keys",
  component: () => (
    <RequireAuth>
      <SettingsApiKeysPage />
    </RequireAuth>
  ),
});

export const settingsMembersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/members",
  component: () => (
    <RequireAuth>
      <SettingsMembersPage />
    </RequireAuth>
  ),
});

export const settingsWorkspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/workspace",
  component: () => (
    <RequireAuth>
      <SettingsWorkspacePage />
    </RequireAuth>
  ),
});

// v3.20 -- per-user keyboard shortcut customization.
export const settingsShortcutsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/shortcuts",
  component: () => (
    <RequireAuth>
      <SettingsShortcutsPage />
    </RequireAuth>
  ),
});

export const settingsJobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/jobs",
  // The /jobs API is already admin-only; guard the route so a member
  // typing the URL gets redirected instead of an all-403 page.
  component: () => (
    <RequireAdmin>
      <JobsPage />
    </RequireAdmin>
  ),
});

// ---------------------------- Models family ----------------------------
// Outsourcing hardening — weight management and the SAM variant switch
// are workspace-admin surfaces, so both routes use RequireAdmin.

export const modelsYoloRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/models/yolo",
  component: () => (
    <RequireAdmin>
      <ModelsYoloPage />
    </RequireAdmin>
  ),
});

export const modelsSamRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/models/sam",
  component: () => (
    <RequireAdmin>
      <ModelsSamPage />
    </RequireAdmin>
  ),
});

// ------------------------------- Trash -------------------------------

export const trashRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/trash",
  component: () => (
    <RequireAuth>
      <TrashPage />
    </RequireAuth>
  ),
});

// ------------------------------- About -------------------------------

export const aboutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/about",
  component: () => (
    <RequireAuth>
      <AboutPage />
    </RequireAuth>
  ),
});

// ------------------------------ System ------------------------------

export const systemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/system",
  component: () => (
    <RequireAdmin>
      <SystemPage />
    </RequireAdmin>
  ),
});
