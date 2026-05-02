// Armin Mehri — mehri.armin@gmail.com
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
/**
 * Canvas backdrop pattern. ``"none"`` is the default — best for opaque
 * images and transparent images alike. ``"subtle"`` and ``"visible"`` are
 * opt-in. See ``.canvas-checker`` in ``global.css`` for the rendering.
 */
export type CanvasPattern = "none" | "subtle" | "visible";

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
  canvasPattern: CanvasPattern;

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
  /** Pixel size of polygon vertex handles. 4–12. */
  controlPointsSize: number;

  // Appearance panel (right-panel) — v2.6.
  /**
   * When true, the canvas draws a 1px border at ``outlinedBorderColor``
   * around every shape on top of its class-color stroke. Mirrors CVAT's
   * "Outlined borders" toggle. Default off.
   */
  outlinedBorders: boolean;
  /**
   * Color used by the outlined-borders overlay. Stored as a CSS hex string
   * so it round-trips to/from the color picker without conversion.
   */
  outlinedBorderColor: string;
  /**
   * Renders projection axes for skeleton/keypoint annotations. Stored on
   * the settings object so the user's preference survives the v3 upgrade,
   * but the UI is currently disabled because no projection-capable tool
   * exists yet.
   */
  showProjections: boolean;

  // CVAT-feature parity (deferred — UI shows them disabled with a tooltip
  // explaining the dependency). Storing the values on the settings object
  // means future implementations can pick the user's preference up without
  // a localStorage migration.
  showAllInterpolationTracks: boolean;
  automaticBordering: boolean;
  intelligentPolygonCropping: boolean;
  aamZoomMargin: number;
}

const STORAGE_KEY = "carve.settings.v1";

/**
 * Persisted-state schema version. Bumped to 2 in v3.0 to migrate users
 * who had ``colorBy: "instance"`` carried over from an earlier session
 * (every new bbox got a different color even though the class was the
 * same). The migration is one-shot: when an old payload is read we flip
 * ``instance`` → ``label`` and stamp the new version. The "Instance"
 * radio remains available for users who explicitly opt back in.
 */
const STORAGE_VERSION = 2;

export const DEFAULT_SETTINGS: EditorSettings = {
  // Player
  playerStep: 1,
  playerSpeed: "usual",
  resetZoomOnFrameChange: false,
  smoothImage: true,
  canvasBgColor: "#0F0F12",
  canvasPattern: "none",

  // Workspace
  autoSaveIntervalSeconds: 1.5,
  colorBy: "label",
  opacity: 25,
  selectedOpacity: 50,
  showLabelText: {
    id: false,
    source: false,
    label: true,
    attributes: false,
    descriptions: false,
  },
  labelPosition: "auto",
  labelFontSize: 14,
  showTagsOnFrame: true,
  polygonApproxPoints: 50,
  controlPointsSize: 9,

  // Appearance panel defaults.
  outlinedBorders: false,
  outlinedBorderColor: "#FFFFFF",
  showProjections: false,

  // Deferred CVAT parity — value preserved but UI is disabled.
  showAllInterpolationTracks: false,
  automaticBordering: false,
  intelligentPolygonCropping: false,
  aamZoomMargin: 100,
};

function isValidPartial(input: unknown): input is Partial<EditorSettings> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

interface PersistedShape extends Partial<EditorSettings> {
  _v?: number;
}

/**
 * One-shot migrations applied when reading an older persisted payload.
 * v1 → v2: ``colorBy: "instance"`` is reset to ``"label"`` so that
 * existing users get the predictable per-class palette by default.
 * They can still opt back into instance coloring via the Appearance
 * panel.
 */
function migrate(parsed: PersistedShape): PersistedShape {
  const version = typeof parsed._v === "number" ? parsed._v : 1;
  if (version >= STORAGE_VERSION) return parsed;
  const next: PersistedShape = { ...parsed };
  if (next.colorBy === "instance") {
    next.colorBy = "label";
  }
  next._v = STORAGE_VERSION;
  return next;
}

function loadFromStorage(): EditorSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidPartial(parsed)) return DEFAULT_SETTINGS;
    const migrated = migrate(parsed as PersistedShape);
    // Merge over defaults so newly added keys retain their defaults when
    // an old stored object is missing them.
    const merged: EditorSettings = {
      ...DEFAULT_SETTINGS,
      ...migrated,
      showLabelText: {
        ...DEFAULT_SETTINGS.showLabelText,
        ...(migrated.showLabelText ?? {}),
      },
    };
    // If migration produced a different shape, persist the upgraded
    // payload immediately so the same migration does not run again.
    if ((parsed as PersistedShape)._v !== STORAGE_VERSION) {
      try {
        window.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ ...merged, _v: STORAGE_VERSION }),
        );
      } catch {
        /* ignore — we'll re-persist on the next setting change */
      }
    }
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function persist(state: EditorSettings): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...state, _v: STORAGE_VERSION }),
    );
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
