import type { ScheduleConfig } from "./schedule";
import type { Court } from "./courts";
export type VenueSettings = {
  courts?: Court[];
  schedule_config?: ScheduleConfig | null;
  id: boolean;
  name: string;
  tagline: string;
  address: string;
  city: string;
  phone: string;
  email: string;
  facebook_url: string;
  hourly_rate: number | null;
  evening_hourly_rate: number;
  evening_start_hour: number;
  equipment_rental_price: number;
  equipment_ball_count: number;
  private_court_capacity: number;
  opening_hour: number | null;
  closing_hour: number | null;
  hold_minutes: number;
  booking_enabled: boolean;
  open_play_enabled: boolean;
  open_play_start_hour: number;
  open_play_end_hour: number;
  weekend_court_end_hour: number;
  open_play_price: number;
  open_play_capacity: number | null;
  gcash_name: string;
  gcash_number: string;
  gcash_qr_url: string;
  cancellation_policy: string;
};

export const defaultVenue: VenueSettings = {
  id: true,
  name: "Rally Club",
  tagline: "Less screen time. More court time.",
  address: "",
  city: "",
  phone: "",
  email: "",
  facebook_url: "",
  hourly_rate: 100,
  evening_hourly_rate: 200,
  evening_start_hour: 16,
  equipment_rental_price: 30,
  equipment_ball_count: 1,
  private_court_capacity: 8,
  opening_hour: 6,
  closing_hour: 22,
  hold_minutes: 30,
  booking_enabled: false,
  open_play_enabled: true,
  open_play_start_hour: 9,
  open_play_end_hour: 16,
  weekend_court_end_hour: 9,
  open_play_price: 50,
  open_play_capacity: 24,
  gcash_name: "",
  gcash_number: "",
  gcash_qr_url: "",
  cancellation_policy:
    "Cancellation and refund details will be announced before reservations open.",
};

export type BookingStatus =
  | "awaiting_payment"
  | "awaiting_verification"
  | "confirmed"
  | "cancelled"
  | "expired"
  | "blocked";
export type PaymentOption = "full" | "reservation_fee";
export type Booking = {
  id: string;
  reference: string;
  user_id: string | null;
  court_id: number | null;
  booking_type: "court" | "open_play";
  participant_count: number;
  booking_date: string;
  start_hour: number;
  duration: number;
  total_amount: number;
  payment_option: PaymentOption;
  initial_payment_amount: number;
  paid_amount: number;
  balance_payment_method:
    | "cash"
    | "gcash"
    | "bank_transfer"
    | "card"
    | "other"
    | null;
  balance_payment_reference: string | null;
  balance_paid_at: string | null;
  equipment_rental: boolean;
  equipment_quantity?: number;
  equipment_unit_price?: number;
  equipment_amount: number;
  equipment_ball_count: number;
  status: BookingStatus;
  hold_expires_at: string | null;
  payment_reference: string | null;
  customer_name: string;
  customer_phone: string;
  notes: string | null;
  created_at: string;
};
export type Availability = Pick<
  Booking,
  "court_id" | "start_hour" | "duration" | "status"
>;
export type VenueResult = {
  courtsReady?: boolean;
  venue: VenueSettings;
  ready: boolean;
  openPlayReady: boolean;
};
export type OpenPlayAvailability = {
  enabled: boolean;
  start_hour: number;
  end_hour: number;
  price: number;
  capacity: number | null;
  players: number;
  remaining: number | null;
  conflict: boolean;
};

export const statusLabels: Record<BookingStatus, string> = {
  awaiting_payment: "Awaiting payment",
  awaiting_verification: "Payment under review",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
  expired: "Expired",
  blocked: "Court blocked",
};
