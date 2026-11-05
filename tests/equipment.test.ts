import test from "node:test";
import assert from "node:assert/strict";
import {
  bookingSchema,
  openPlaySchema,
  calculateReservationTotal,
  equipmentBookingLabel,
  equipmentPackageLabel,
  savedEquipmentQuantity,
  privateEquipmentLimit,
} from "../src/lib/booking";
import { defaultVenue } from "../src/lib/types";

test("rental quantities multiply the session price once and preserve centavos", () => {
  assert.equal(calculateReservationTotal(200, 30, 3), 290);
  assert.equal(calculateReservationTotal(600, 30, 3), 690);
  assert.equal(calculateReservationTotal(100, 30, 0), 100);
  assert.equal(calculateReservationTotal(100, 0, 3), 100);
  assert.equal(calculateReservationTotal(100.1, 30.2, 3), 190.7);
  assert.equal(calculateReservationTotal(100, 30.01, 3), 190.03);
});
test("rental descriptions use saved quantities and preserve one-set historical bookings", () => {
  assert.equal(equipmentPackageLabel(1, 3), "3 paddles + 3 balls");
  assert.equal(equipmentPackageLabel(2, 3), "3 paddles + 6 balls");
  assert.equal(savedEquipmentQuantity({ equipment_rental: true }), 1);
  assert.equal(savedEquipmentQuantity({ equipment_rental: false }), 0);
  assert.equal(
    equipmentBookingLabel({
      equipment_rental: true,
      equipment_quantity: 3,
      equipment_ball_count: 1,
    }),
    "3 equipment sets · 3 paddles + 3 balls",
  );
  assert.equal(
    equipmentBookingLabel({ equipment_rental: true }),
    "1 equipment set · 1 paddle + 2 balls",
  );
});
test("rental quantity validation rejects malformed values and uses the lowest private capacity across booked hours", () => {
  const input = {
    court_id: 1,
    booking_date: "2026-10-28",
    start_hour: 6,
    duration: 1,
    customer_name: "Player",
    customer_phone: "09171234567",
  };
  for (const quantity of [-1, 101, 1.5, "3", null, NaN])
    assert.equal(
      bookingSchema.safeParse({ ...input, equipment_quantity: quantity })
        .success,
      false,
    );
  assert.equal(
    bookingSchema.parse({ ...input, equipment_quantity: 3 }).equipment_quantity,
    3,
  );
  assert.equal(
    openPlaySchema.parse({
      ...input,
      participant_count: 3,
      equipment_quantity: 2,
    }).equipment_quantity,
    2,
  );
  const venue = {
    ...defaultVenue,
    schedule_config: {
      weekly: [
        {
          id: "first",
          days: [1, 2, 3, 4, 5, 6, 7],
          kind: "court" as const,
          start: 6,
          end: 7,
          rate: 100,
          capacity: 8,
        },
        {
          id: "next",
          days: [1, 2, 3, 4, 5, 6, 7],
          kind: "court" as const,
          start: 7,
          end: 9,
          rate: 100,
          capacity: 4,
        },
      ],
      overrides: [],
    },
  };
  assert.equal(privateEquipmentLimit(venue, "2026-10-28", 6, 1), 8);
  assert.equal(privateEquipmentLimit(venue, "2026-10-28", 6, 2), 4);
});
