import { api } from "./client";

export type Role = "admin" | "member" | "viewer";

export interface Member {
  id: string;
  email: string;
  role: Role;
}

export const membersApi = {
  list: async (): Promise<Member[]> =>
    (await api.get<Member[]>("/auth/members")).data,
  setRole: async (userId: string, role: Role): Promise<Member> =>
    (await api.patch<Member>(`/auth/members/${userId}/role`, { role })).data,
};
