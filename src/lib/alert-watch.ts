import type { DeskAlert } from "@/lib/alerts";

/**
 * Alerts that weren't firing on the previous read. `seen` is null before the first read of
 * a wallet set, which only sets the baseline: what's already wrong when the page opens is
 * on screen, so only what goes wrong afterwards is worth a notification.
 */
export function freshAlerts(seen: ReadonlySet<string> | null, alerts: DeskAlert[]): DeskAlert[] {
  if (!seen) return [];
  return alerts.filter((alert) => !seen.has(alert.id));
}

/** The tab title, with the alert count in front so a background tab still shows trouble. */
export function titleWithAlerts(base: string, alerts: DeskAlert[]): string {
  if (alerts.length === 0) return base;
  const critical = alerts.some((alert) => alert.severity === "critical");
  return `(${alerts.length}${critical ? "!" : ""}) ${base}`;
}
