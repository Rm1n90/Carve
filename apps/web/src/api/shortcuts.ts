// Armin Mehri -- mehri.armin@gmail.com
//
// HTTP wrapper for ``/me/shortcuts``. Mirrors the backend router 1:1.
import { api } from "./client";

export interface ShortcutOverridesPayload {
  overrides: Record<string, string>;
}

export const shortcutsApi = {
  get: async (): Promise<ShortcutOverridesPayload> =>
    (await api.get<ShortcutOverridesPayload>("/me/shortcuts")).data,

  put: async (
    overrides: Record<string, string>,
  ): Promise<ShortcutOverridesPayload> =>
    (
      await api.put<ShortcutOverridesPayload>("/me/shortcuts", {
        overrides,
      })
    ).data,

  resetOne: async (actionId: string): Promise<ShortcutOverridesPayload> =>
    (
      await api.delete<ShortcutOverridesPayload>(
        `/me/shortcuts/${encodeURIComponent(actionId)}`,
      )
    ).data,

  resetAll: async (): Promise<ShortcutOverridesPayload> =>
    (await api.delete<ShortcutOverridesPayload>("/me/shortcuts")).data,
};
