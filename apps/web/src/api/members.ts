// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";
import type { ApiKey } from "./api_keys";

export type Role = "superadmin" | "admin" | "member" | "viewer";

/** Roles allowed in the v3.0 admin-invite dialog. ``viewer`` is intentionally
 * excluded — the existing role-edit dropdown still surfaces it for legacy
 * accounts, but new invites pick between admin and member. (Bug 14) */
export type CreateRole = "admin" | "member";

export interface Member {
  id: string;
  email: string;
  role: Role;
  /** Blocked accounts cannot log in and their live sessions stop working
   * on the next request. Reversible — see ``unblock``. */
  blocked?: boolean;
  blocked_at?: string | null;
  blocked_reason?: string | null;
  /** From the activity log; null until they sign in after it started
   * recording sign-ins (2026-11-01). */
  last_sign_in_at?: string | null;
}

/** A removed (soft-deleted) account, which a superadmin can restore. */
export interface RemovedMember {
  id: string;
  email: string;
  role: Role;
  deleted_at: string;
}

export interface MemberProject {
  project_id: string;
  project_name: string;
  role: string;
}

export type MemberProjectsByUser = Record<string, MemberProject[]>;

export const membersApi = {
  list: async (): Promise<Member[]> =>
    (await api.get<Member[]>("/auth/members")).data,
  /** Per-user project memberships for the Settings → Members admin
   * surface, so admins can see WHICH projects each member can access. */
  projectsByUser: async (): Promise<MemberProjectsByUser> =>
    (await api.get<MemberProjectsByUser>("/auth/members/projects-by-user"))
      .data,
  setRole: async (userId: string, role: Role): Promise<Member> =>
    (await api.patch<Member>(`/auth/members/${userId}/role`, { role })).data,
  /** Bug 14 — admin invites a new member (email + initial password + role). */
  create: async (
    email: string,
    password: string,
    role: CreateRole,
  ): Promise<Member> =>
    (await api.post<Member>("/auth/members", { email, password, role })).data,
  /** Bug 14 — admin soft-deletes a member. */
  delete: async (userId: string): Promise<void> => {
    await api.delete(`/auth/members/${userId}`);
  },

  // --- superadmin account controls -------------------------------------
  // All four return 403 ``superadmin_only`` for anyone below the top tier.

  /** Set another user's password without knowing the current one. Also
   * revokes every session that user currently holds, so an already-open
   * tab cannot keep working. Carve does not notify them — tell them. */
  setPassword: async (userId: string, newPassword: string): Promise<void> => {
    await api.post(`/auth/members/${userId}/password`, {
      new_password: newPassword,
    });
  },
  /** Block an account. Reversible, and takes effect on the target's very
   * next request. Prefer this over deletion for "they should not be here
   * right now" — annotations stay attributed either way. */
  block: async (userId: string, reason?: string): Promise<Member> =>
    (await api.post<Member>(`/auth/members/${userId}/block`, { reason })).data,
  unblock: async (userId: string): Promise<Member> =>
    (await api.post<Member>(`/auth/members/${userId}/unblock`)).data,
  /** Force-logout: invalidate every token the user holds. The account
   * stays active, so they can simply log in again. */
  revokeSessions: async (userId: string): Promise<void> => {
    await api.post(`/auth/members/${userId}/revoke-sessions`);
  },

  /** Change the email they sign in with (superadmin). Their single
   * sign-on link is cleared; their password stays. */
  setEmail: async (userId: string, email: string): Promise<Member> =>
    (await api.patch<Member>(`/auth/members/${userId}/email`, { email })).data,
  /** Their API keys, never the keys themselves (superadmin). */
  apiKeys: async (userId: string): Promise<ApiKey[]> =>
    (await api.get<ApiKey[]>(`/auth/members/${userId}/api-keys`)).data,
  revokeApiKey: async (userId: string, keyId: string): Promise<void> => {
    await api.delete(`/auth/members/${userId}/api-keys/${keyId}`);
  },
  /** Removed accounts, newest first (superadmin). */
  removed: async (): Promise<RemovedMember[]> =>
    (await api.get<RemovedMember[]>("/auth/members/removed")).data,
  /** Bring a removed account back with its role, password and work. */
  restore: async (userId: string): Promise<Member> =>
    (await api.post<Member>(`/auth/members/${userId}/restore`)).data,
};
