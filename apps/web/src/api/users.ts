/**
 * Plan-09b Task 4 — Users / workspace-members API + reviewer-name resolver.
 *
 * The API surface is intentionally small: a single ``listMembers`` call backed
 * by the existing ``GET /auth/members`` endpoint, plus a tanstack-query hook
 * (``useUsers``) used by the annotate page to feed ``ReviewPanel``'s
 * ``resolveReviewerName`` prop.
 *
 * The backend currently returns ``{id, email, role}`` (see
 * ``apps/api/src/carve_api/auth/schemas.py::UserOut``) — no first-class ``name``
 * field exists yet. We accept an optional ``name`` so the resolver future-proofs
 * for when the backend grows one, and we fall back to ``email`` so the review
 * row still renders something human-readable today.
 */
import { useQuery } from "@tanstack/react-query";

import { api } from "./client";

export interface WorkspaceUser {
  id: string;
  email: string;
  /** Optional — backend currently does not return a ``name`` field. */
  name?: string | null;
}

export const usersApi = {
  /** GET /auth/members — workspace member list. */
  listMembers: async (): Promise<WorkspaceUser[]> =>
    (await api.get<WorkspaceUser[]>("/auth/members")).data,
};

const FIVE_MINUTES_MS = 5 * 60 * 1000;

/**
 * Cached workspace-member fetcher. Used by the annotate page to resolve
 * reviewer ids → display names. ``staleTime`` is 5 minutes — names rarely
 * change during an annotate session.
 */
export function useUsers() {
  return useQuery({
    queryKey: ["workspace-members"] as const,
    queryFn: usersApi.listMembers,
    staleTime: FIVE_MINUTES_MS,
  });
}

/** Pick the best display name for a user — name if present, else email. */
export function displayNameFor(u: WorkspaceUser): string {
  return (u.name && u.name.trim()) || u.email;
}
