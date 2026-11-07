// Armin Mehri — mehri.armin@gmail.com
/**
 * Which AI tools to offer on one task, from the superadmin's Member access
 * settings (Settings → Configuration). Like the rest of
 * {@link ./capabilities}, this only keeps tools a member may not use off
 * the screen; the API refuses them on its own.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { hasAdminAuthority } from "./capabilities";
import { useAuth } from "./store";

export type AiTool = "sam" | "my_model" | "yoloe" | "logo_ai";
/** Who below admin may use a tool. */
export type MemberMode = "admins" | "opened_tasks" | "all_tasks";
export type AiAccess = Record<AiTool, boolean>;

const ALL: AiAccess = { sam: true, my_model: true, yoloe: true, logo_ai: true };
const NONE: AiAccess = { sam: false, my_model: false, yoloe: false, logo_ai: false };

export const aiAccessApi = {
  modes: async (): Promise<Record<AiTool, MemberMode>> =>
    (await api.get<Record<AiTool, MemberMode>>("/workspace/ai-access")).data,
};

/**
 * Admins get every tool. A member gets a tool set to "every task", or to
 * "tasks opened for them" when this task's AI tools for members switch is
 * on. While the task or the settings are loading a member gets nothing,
 * so no tool flashes into view and then disappears.
 */
export function useAiToolAccess(
  task: { gpu_access_for_members?: boolean } | null | undefined,
): AiAccess {
  const role = useAuth((s) => s.user?.role ?? null);
  const admin = hasAdminAuthority(role);
  const modes = useQuery({
    queryKey: ["workspace", "ai-access"],
    queryFn: aiAccessApi.modes,
    enabled: !admin,
    staleTime: 60_000,
  });
  if (admin) return ALL;
  if (!task || !modes.data) return NONE;
  const opened = task.gpu_access_for_members === true;
  const allowed = (tool: AiTool) => {
    const mode = modes.data[tool];
    return mode === "all_tasks" || (mode === "opened_tasks" && opened);
  };
  return {
    sam: allowed("sam"),
    my_model: allowed("my_model"),
    yoloe: allowed("yoloe"),
    logo_ai: allowed("logo_ai"),
  };
}
