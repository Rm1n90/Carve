// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";

/** Database dumps on disk and "Back up now" (`/admin/backups`, superadmin). */
export interface BackupFile {
  tier: "daily" | "weekly" | "monthly";
  name: string;
  size_bytes: number;
  created_at: string;
}

export interface BackupsListing {
  /** False when the API cannot see the backups folder. */
  available: boolean;
  /** A dump is being written right now. */
  running: boolean;
  /** "Back up now" pressed; the backup service has not taken it yet. */
  requested_at: string | null;
  files: BackupFile[];
}

export const backupsApi = {
  list: async (): Promise<BackupsListing> =>
    (await api.get<BackupsListing>("/admin/backups")).data,
  run: async (): Promise<BackupsListing> =>
    (await api.post<BackupsListing>("/admin/backups/run")).data,
};
