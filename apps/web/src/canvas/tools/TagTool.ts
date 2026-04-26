import { useAnnotations } from "@/state/annotations";

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
    if (!classId) return false;
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
    return true;
  }
}
