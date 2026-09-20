import { Circle, Download, type LucideIcon } from "lucide-react";

export type ShortStatus = "recorded" | "exported";

export function getShortStatus(
  videoId: string,
  exportedMap: Record<string, boolean>
): ShortStatus {
  return exportedMap[videoId] ? "exported" : "recorded";
}

export const STATUS_META: Record<
  ShortStatus,
  { label: string; icon: LucideIcon }
> = {
  recorded: { label: "Recorded", icon: Circle },
  exported: { label: "Exported", icon: Download },
};
