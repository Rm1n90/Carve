// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";

/** One entry of the workspace activity log (`GET /audit`, superadmin). */
export interface AuditEvent {
  id: string;
  occurred_at: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  project_id: string | null;
  project_name: string | null;
  summary: string;
  metadata: Record<string, unknown> | null;
}

export interface AuditPage {
  items: AuditEvent[];
  next_cursor: string | null;
}

export interface AuditFilter {
  /** One action or several, comma-separated. */
  action?: string;
  /** A family of actions, e.g. "user.". */
  action_prefix?: string;
  /** What someone did and what was done to them. */
  person?: string;
}

export const auditApi = {
  workspace: async (filter: AuditFilter, cursor?: string | null): Promise<AuditPage> =>
    (
      await api.get<AuditPage>("/audit", {
        params: { ...filter, cursor: cursor ?? undefined, limit: 50 },
      })
    ).data,
};
