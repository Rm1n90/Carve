// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";

export interface ClassKeybinding {
  digit: number; // 1..9
  class_id: string;
  source: "stored" | "seed";
}

export interface ClassKeybindingList {
  bindings: ClassKeybinding[];
}

export const keybindingsApi = {
  /** Read the user's effective bindings for a project (stored ∪ seed). */
  list: async (projectId: string): Promise<ClassKeybindingList> =>
    (await api.get<ClassKeybindingList>(
      `/projects/${projectId}/class-keybindings`,
    )).data,

  /** Bind / move a digit. Server enforces the move-not-duplicate rule. */
  put: async (
    projectId: string,
    digit: number,
    classId: string,
  ): Promise<ClassKeybinding> =>
    (await api.put<ClassKeybinding>(
      `/projects/${projectId}/class-keybindings/${digit}`,
      { class_id: classId },
    )).data,

  /** Idempotent — clears the digit. */
  remove: async (projectId: string, digit: number): Promise<void> => {
    await api.delete(`/projects/${projectId}/class-keybindings/${digit}`);
  },
};
