/**
 * Booking caveats: services that run but that the usual booking sites may not sell (Route.flags, CAVEAT_FLAGS).
 * Shown as a small info badge next to the route's name in lists, and as a sentence in the trip's schedule.
 */
import { Cat, Flag, type Route } from "@etbm/shared";

export interface BookingCaveat {
  /** Short label for badges / screen readers ("Reservation only"). */
  label: string;
  /** Full sentence shown in the schedule and as the badge's tooltip. */
  text: string;
}

export function bookingCaveat(r: Pick<Route, "flags" | "cat">): BookingCaveat | null {
  if (r.flags & Flag.ReservationOnly) {
    const what = r.cat === Cat.Bus || r.cat === Cat.Coach ? "coach" : "service";
    return {
      label: "Reservation only",
      text: `Reservation-only ${what} – may not be offered on the usual booking sites; check with the operator.`,
    };
  }
  return null;
}
