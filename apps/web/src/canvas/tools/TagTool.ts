// Armin Mehri — mehri.armin@gmail.com
import { useAnnotations } from "@/state/annotations";
import { useTool } from "@/state/tool";
import { showToast } from "@/lib/toast";

export class TagTool {
  constructor(
    private getActiveClassId: () => string | null,
    private getFrameId: () => string | null,
    private generateTempId: () => string = () => `t-${Math.random().toString(36).slice(2)}`,
  ) {}

  /** Add a frame-level tag annotation for the active class. Idempotent: if a tag
   *  with the same classId + frameId already exists in the local store, returns false. */
  apply(): boolean {
    const classId = this.getActiveClassId();
    if (!classId) {
      showToast("Pick a class first", { variant: "warning" });
      return false;
    }
    const frameId = this.getFrameId();
    const existing = Object.values(useAnnotations.getState().byId).find(
      (a) => a.kind === "tag" && a.classId === classId && a.frameId === frameId,
    );
    if (existing) return false;
    useAnnotations.getState().add({
      tempId: this.generateTempId(),
      classId,
      kind: "tag",
      geometry: { kind: "tag" },
      frameId,
      serverId: null,
      dirty: true,
    });
    // F4 — record tool-driven draw for streak.
    useTool.getState().recordDraw(classId);
    return true;
  }
}
