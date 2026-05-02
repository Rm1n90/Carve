// Armin Mehri — mehri.armin@gmail.com
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Combine class names with Tailwind-aware deduplication.
 * Pattern: cn("p-4", isActive && "bg-accent", custom)
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
