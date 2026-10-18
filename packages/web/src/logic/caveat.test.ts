import { describe, expect, it } from "vitest";
import { Cat, Flag } from "@etbm/shared";
import { bookingCaveat } from "./caveat.ts";

describe("booking caveat", () => {
  it("explains reservation-only coaches", () => {
    const c = bookingCaveat({ cat: Cat.Bus, flags: Flag.ReservationOnly })!;
    expect(c.label).toBe("Reservation only");
    expect(c.text).toMatch(/^Reservation-only coach – may not be offered on the usual booking sites/);
    expect(bookingCaveat({ cat: Cat.Regional, flags: Flag.ReservationOnly | Flag.Night })!.text).toMatch(/^Reservation-only service/);
  });
  it("is absent for ordinary services and night trains", () => {
    expect(bookingCaveat({ cat: Cat.Bus, flags: 0 })).toBeNull();
    expect(bookingCaveat({ cat: Cat.LongDistance, flags: Flag.Night })).toBeNull();
  });
});
