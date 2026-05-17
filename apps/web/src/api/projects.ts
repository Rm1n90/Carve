// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";

export interface Project {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  // v3.3 Issue 2 — backend resolves the owner's email via a JOIN to users
  // so the UI can render a friendly "Created by …" label. Nullable to
  // tolerate orphaned/missing owner rows.
  owner_email: string | null;
  created_at: string;
  /**
   * v3.32 — per-project preferred SAM variant. ``null`` means "no
   * preference; use the workspace default". Optional on the wire to
   * tolerate responses from older API versions (pre-0035 migration)
   * that don't carry the field.
   */
  default_sam_variant?: string | null;
}

export interface ProjectIn {
  name: string;
  description?: string;
}

/**
 * v3.32 — PATCH body shape. Mirrors backend ``ProjectPatch``. An
 * explicit ``null`` on ``default_sam_variant`` clears the project's
 * preference; omitting the key leaves it unchanged. Only project
 * owner / workspace admin can change ``default_sam_variant`` — non-
 * authorised callers receive 403 ``insufficient_role`` from the
 * backend.
 */
export interface ProjectPatch {
  name?: string;
  description?: string | null;
  default_sam_variant?: string | null;
}

export interface ImportClassesResult {
  imported: number;
  skipped: number;
}

export const projectsApi = {
  list: async (): Promise<Project[]> => (await api.get<Project[]>("/projects")).data,
  get: async (id: string): Promise<Project> =>
    (await api.get<Project>(`/projects/${id}`)).data,
  create: async (input: ProjectIn): Promise<Project> =>
    (await api.post<Project>("/projects", input)).data,
  update: async (
    id: string,
    patch: ProjectPatch | Partial<ProjectIn>,
  ): Promise<Project> =>
    (await api.patch<Project>(`/projects/${id}`, patch)).data,
  delete: async (id: string): Promise<void> => {
    await api.delete(`/projects/${id}`);
  },
  importClasses: async (
    projectId: string,
    sourceProjectId: string,
  ): Promise<ImportClassesResult> =>
    (
      await api.post<ImportClassesResult>(
        `/projects/${projectId}/classes/import`,
        { source_project_id: sourceProjectId },
      )
    ).data,
};
