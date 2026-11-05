import { z } from "zod";

export type CustomerBookingAction =
  | "reserve_court"
  | "reserve_open_play"
  | "cancel"
  | "payment";

type RpcError = { code?: string; message: string };
type RequestClient = {
  rpc(
    name: "request_customer_booking_v2",
    args: { p_action: CustomerBookingAction; p_input: unknown },
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
};

const responseSchema = z.union([
  z.object({ id: z.uuid() }),
  z.object({ success: z.literal(true) }),
  z.object({
    error: z.string().min(1),
    code: z.string(),
    retry_after_seconds: z.number().int().min(1).max(600).optional(),
  }),
]);

export type CustomerBookingResult = {
  id?: string;
  success?: boolean;
  error?: string;
  retryAfterSeconds?: number;
};

export function bookingError(error: RpcError) {
  if (error.code === "23P01")
    return "That time was just reserved. Please choose another slot.";
  if (["PGRST202", "PGRST205"].includes(error.code || ""))
    return "Reservations are being updated. Please check back soon.";
  return error.message.startsWith("Booking: ")
    ? error.message.slice(9)
    : "We couldn’t complete that request. Please refresh and try again.";
}

// All customer mutations use the same persistent database gate, including
// invalid forms. Never fall back to an older RPC when the migration is missing.
export async function requestCustomerBooking(
  client: RequestClient,
  action: CustomerBookingAction,
  input: unknown,
  validationError?: string,
): Promise<CustomerBookingResult> {
  try {
    const { data, error } = await client.rpc("request_customer_booking_v2", {
      p_action: action,
      p_input: validationError ? null : input,
    });
    if (error) return { error: bookingError(error) };
    const result = responseSchema.safeParse(data);
    if (!result.success)
      return {
        error:
          "We couldn’t complete that request. Please refresh and try again.",
      };
    if ("error" in result.data)
      return {
        error:
          result.data.code === "INVALID_INPUT" && validationError
            ? validationError
            : result.data.error,
        ...(result.data.retry_after_seconds
          ? { retryAfterSeconds: result.data.retry_after_seconds }
          : {}),
      };
    // An invalid local form must never be reported as a successful mutation.
    if (validationError) return { error: validationError };
    if (action.startsWith("reserve_"))
      return "id" in result.data
        ? result.data
        : {
            error:
              "We couldn’t complete that reservation. Please refresh and try again.",
          };
    return "success" in result.data
      ? result.data
      : {
          error:
            "We couldn’t complete that request. Please refresh and try again.",
        };
  } catch {
    return {
      error: "We couldn’t complete that request. Please refresh and try again.",
    };
  }
}
