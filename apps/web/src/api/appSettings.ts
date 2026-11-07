// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";

/**
 * Settings a superadmin changes in the app instead of in `.env`
 * (`/admin/settings`, superadmin-only). A saved value takes precedence
 * over the environment variable of the same name; clearing it goes back
 * to the environment. Secrets come back only as their last four
 * characters (`hint`).
 */

export type SettingKind = "secret" | "text" | "url" | "int" | "float" | "bool" | "choice";
/** Which part of Carve reads it, and so when a change applies. */
export type SettingService = "api" | "model" | "backup";
export type SettingSource = "app" | "env" | "default";

export interface AppSetting {
  key: string;
  group: string;
  label: string;
  help: string;
  kind: SettingKind;
  minimum: number | null;
  maximum: number | null;
  unit: string | null;
  choices: string[];
  allow_empty: boolean;
  testable: boolean;
  service: SettingService;
  /** Allowed values of a "choice" setting. */
  options: string[];
  /** What the page shows for each of `options` (same order); may be empty. */
  option_labels: string[];
  /** Pages where the value is made or managed, e.g. the provider's key page. */
  links: { label: string; url: string }[];
  source: SettingSource;
  env_set: boolean;
  /** A saved secret that can no longer be decrypted: enter it again. */
  unreadable: boolean;
  updated_at: string | null;
  updated_by: string | null;
  /** The value in use; always null for secrets. */
  value: string | number | boolean | null;
  /** Secrets: the value in use as "…abcd", or null when none. */
  hint: string | null;
  /** Secrets: the `.env` value as "…abcd", or null. */
  env_hint: string | null;
}

export interface StartupSetting {
  key: string;
  label: string;
  secret: boolean;
  set: boolean;
}

export interface ModelServiceStatus {
  reachable: boolean;
  /** Running, but started before the latest saved model settings. */
  pending_restart: boolean;
}

export interface AppSettingsListing {
  settings: AppSetting[];
  startup: StartupSetting[];
  applies_within_seconds: number;
  services: { model: ModelServiceStatus };
}

export interface KeyTestResult {
  ok: boolean;
  message: string;
}

export const appSettingsApi = {
  list: async (): Promise<AppSettingsListing> =>
    (await api.get<AppSettingsListing>("/admin/settings")).data,
  save: async (key: string, value: unknown): Promise<AppSettingsListing> =>
    (await api.put<AppSettingsListing>(`/admin/settings/${key}`, { value })).data,
  clear: async (key: string): Promise<AppSettingsListing> =>
    (await api.delete<AppSettingsListing>(`/admin/settings/${key}`)).data,
  restartModel: async (): Promise<AppSettingsListing> =>
    (await api.post<AppSettingsListing>("/admin/settings/services/model/restart")).data,
  test: async (key: string, value?: string): Promise<KeyTestResult> =>
    (await api.post<KeyTestResult>(`/admin/settings/${key}/test`, value ? { value } : {})).data,
};
