import { api } from "./client";

export type ProjectMemberRole = "owner" | "admin" | "member" | "viewer";
export type InviteRole = "admin" | "member" | "viewer";

export interface InviteCreated {
  id: string;
  project_id: string;
  email: string;
  role: ProjectMemberRole;
  /** Raw invite token. Returned exactly once at create-time. */
  token: string;
  expires_at: string;
}

export interface InviteListItem {
  id: string;
  project_id: string;
  email: string;
  role: ProjectMemberRole;
  invited_by: string | null;
  created_at: string;
  expires_at: string;
}

export interface InvitePreview {
  project_id: string;
  project_name: string;
  email: string;
  role: ProjectMemberRole;
  requires_password: boolean;
}

export interface InviteAcceptUser {
  id: string;
  email: string;
  role: string;
}

export interface InviteAcceptResult {
  user: InviteAcceptUser;
  project_id: string;
  role: ProjectMemberRole;
  jwt: string | null;
  refresh_token: string | null;
}

export interface InviteAcceptInput {
  token: string;
  password?: string;
}

export const invitesApi = {
  create: async (
    projectId: string,
    email: string,
    role: InviteRole,
  ): Promise<InviteCreated> =>
    (
      await api.post<InviteCreated>(`/projects/${projectId}/invites`, {
        email,
        role,
      })
    ).data,
  list: async (projectId: string): Promise<InviteListItem[]> =>
    (await api.get<InviteListItem[]>(`/projects/${projectId}/invites`)).data,
  revoke: async (projectId: string, inviteId: string): Promise<void> => {
    await api.delete(`/projects/${projectId}/invites/${inviteId}`);
  },
  preview: async (token: string): Promise<InvitePreview> =>
    (await api.get<InvitePreview>(`/invites/${token}/preview`)).data,
  accept: async (input: InviteAcceptInput): Promise<InviteAcceptResult> =>
    (await api.post<InviteAcceptResult>("/invites/accept", input)).data,
};

export const projectMembersApi = {
  setRole: async (
    projectId: string,
    userId: string,
    role: ProjectMemberRole,
  ): Promise<{ role: ProjectMemberRole }> =>
    (
      await api.post<{ role: ProjectMemberRole }>(
        `/projects/${projectId}/members/${userId}/role`,
        { role },
      )
    ).data,
  remove: async (projectId: string, userId: string): Promise<void> => {
    await api.delete(`/projects/${projectId}/members/${userId}`);
  },
};
