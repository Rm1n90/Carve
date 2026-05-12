// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";

export type Role = "admin" | "member" | "viewer";

/** Roles allowed in the v3.0 admin-invite dialog. ``viewer`` is intentionally
 * excluded — the existing role-edit dropdown still surfaces it for legacy
 * accounts, but new invites pick between admin and member. (Bug 14) */
export type CreateRole = "admin" | "member";

export interface Member {
  id: string;
  email: string;
  role: Role;
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
};
