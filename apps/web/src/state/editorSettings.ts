import { create } from "zustand";

/**
 * Editor settings — Player + Workspace tabs from the gear-icon dialog
 * (see EditorSettingsDialog.tsx). All values are persisted to
 * localStorage under `carve.settings.v1` and hydrated on app mount.
 *
 * Consumers:
 *  - SaveIndicator's debounce time → autoSaveIntervalSeconds
 *  - AnnotationCanvas color resolver → colorBy
 *  - mask/polygon fill alpha → opacity / selectedOpacity
 *  - canvas-checker bg → canvasBgColor
 *  - sprite scale mode → smoothImage
 *  - label tag → showLabelText / labelFontSize / labelPosition
 *  - poly-approx fidelity → polygonApproxPoints (SAM commit)
 */

export type ColorBy = "label" | "instance" | "group";
export type LabelPosition = "auto" | "above" | "below" | "left" | "right";
export type PlayerSpeed = "slowest" | "slow" | "usual" | "fast" | "fastest";

export interface LabelTextFlags {
  id: boolean;
  source: boolean;
  label: boolean;
  attributes: boolean;
  descriptions: boolean;
}

export interface EditorSettings {
  // Player tab
  playerStep: number;
  playerSpeed: PlayerSpeed;
  resetZoomOnFrameChange: boolean;
  smoothImage: boolean;
  canvasBgColor: string;

  // Workspace tab
  autoSaveIntervalSeconds: number;
  colorBy: ColorBy;
  opacity: number; // 0-100
  selectedOpacity: number; // 0-100
  showLabelText: LabelTextFlags;
  labelPosition: LabelPosition;
  labelFontSize: number;
  showTagsOnFrame: boolean;
  polygonApproxPoints: number; // 0-100
}

const STORAGE_KEY = "carve.settings.v1";

export const DEFAULT_SETTINGS: EditorSettings = {
  // Player
  playerStep: 1,
  playerSpeed: "usual",
  resetZoomOnFrameChange: false,
  smoothImage: true,
  canvasBgColor: "#0F0F12",

  // Workspace
  autoSaveIntervalSeconds: 1.5,
  colorBy: "label",
  opacity: 30,
  selectedOpacity: 50,
  showLabelText: {
    id: false,
    source: false,
    label: true,
    attributes: false,
    descriptions: false,
  },
  labelPosition: "auto",
  labelFontSize: 12,
  showTagsOnFrame: true,
  polygonApproxPoints: 50,
};

function isValidPartial(input: unknown): input is Partial<EditorSettings> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function loadFromStorage(): EditorSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidPartial(parsed)) return DEFAULT_SETTINGS;
    // Merge over defaults so newly added keys retain their defaults when
    // an old stored object is missing them.
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      showLabelText: {
        ...DEFAULT_SETTINGS.showLabelText,
        ...((parsed as Partial<EditorSettings>).showLabelText ?? {}),
      },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function persist(state: EditorSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* localStorage unavailable in some private modes */
  }
}

interface EditorSettingsStore extends EditorSettings {
  set: <K extends keyof EditorSettings>(key: K, value: EditorSettings[K]) => void;
  setLabelTextFlag: (key: keyof LabelTextFlags, value: boolean) => void;
  reset: () => void;
}

export const useEditorSettings = create<EditorSettingsStore>((set, get) => ({
  ...loadFromStorage(),
  set: (key, value) => {
    set({ [key]: value } as Partial<EditorSettings>);
    persist(get());
  },
  setLabelTextFlag: (key, value) => {
    set({ showLabelText: { ...get().showLabelText, [key]: value } });
    persist(get());
  },
  reset: () => {
    set({ ...DEFAULT_SETTINGS });
    persist(get());
  },
}));
