/** Wording for local-transport popups (pure, tested). */

export const URBAN_MODE_LABEL = ["Bus", "Tram", "Metro", "Cable car / funicular"] as const;

/**
 * Frequency band from the trips of one direction on a typical weekday (service hours ~ 16 h):
 * "every ~10 min", "every ~30 min", "a few trips a day".
 */
export function frequencyBand(tpd: number | undefined): string {
  if (!tpd || tpd < 1) return "";
  if (tpd < 8) return `${Math.round(tpd)} trip${Math.round(tpd) === 1 ? "" : "s"} a day`;
  const headway = 960 / tpd;
  if (headway <= 3.5) return "every few minutes";
  const steps = [5, 6, 8, 10, 12, 15, 20, 30, 45, 60, 90, 120];
  const step = steps.find((s) => headway <= s + 0.01 * s) ?? Math.round(headway / 30) * 30;
  return `every ~${step} min`;
}

/** Modes named by a stop's bit mask (bit = 1 << mode), most important first. */
export function stopModes(mask: number): string[] {
  const order = [2, 1, 3, 0];
  return order.filter((m) => mask & (1 << m)).map((m) => URBAN_MODE_LABEL[m]!);
}
