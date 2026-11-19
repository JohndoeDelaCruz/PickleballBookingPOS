import { z } from "zod";
import { money } from "./booking";

export const maxMembershipPrice = 100_000;
export const maxMembershipBenefits = 16;
export const membershipTextLimits = { title: 80, period: 24, body: 500 };
export const membershipBenefitIcons = ["trophy", "wallet", "users", "calendar", "check", "heart", "gift", "coaching"] as const;
export const membershipPlanIds = ["annual", "six-month"] as const;
export type MembershipPlanId = (typeof membershipPlanIds)[number];
export const membershipPlanLabels = { annual: "Annual plan", "six-month": "Six-month plan" } satisfies Record<MembershipPlanId, string>;

function requiredText(label: string, max: number) {
  return z.string().trim().min(1, `Enter ${label}.`).max(max, `Use up to ${max} characters for ${label}.`);
}

const benefitSchema = z.object({
  icon: z.enum(membershipBenefitIcons),
  title: requiredText("a benefit title", membershipTextLimits.title),
  description: requiredText("a benefit description", membershipTextLimits.body),
});

export const membershipDetailsSchema = z.object({
  price_cents: z.number().int().min(0).max(maxMembershipPrice * 100),
  plan_name: requiredText("a plan name", membershipTextLimits.title),
  price_period: requiredText("a price period", membershipTextLimits.period),
  heading: requiredText("a page heading", membershipTextLimits.title),
  introduction: requiredText("an introduction", membershipTextLimits.body),
  validity: requiredText("membership validity terms", membershipTextLimits.body),
  redemption: requiredText("instructions for using benefits", membershipTextLimits.body),
  home_summary: requiredText("a homepage summary", membershipTextLimits.body),
  benefits: z.array(benefitSchema).max(maxMembershipBenefits),
});

const membershipCourtDiscountSchema = z.object({
  enabled: z.boolean(),
  amountCents: z.number().int().min(1).max(maxMembershipPrice * 100),
  minHours: z.number().int().min(1).max(4),
});
export const membershipCourtDiscountStateSchema = membershipCourtDiscountSchema.extend({
  revision: z.number().int().min(0).max(2147483647),
});
export const membershipOpenPlayDiscountSchema = membershipCourtDiscountStateSchema.omit({ minHours: true }).extend({
  floorCents: z.number().int().min(1).max(maxMembershipPrice * 100),
});

export type MembershipDetails = z.infer<typeof membershipDetailsSchema>;
export type MembershipCourtDiscount = z.infer<typeof membershipCourtDiscountStateSchema>;
export type MembershipOpenPlayDiscount = z.infer<typeof membershipOpenPlayDiscountSchema>;
export type MembershipPlan = { id: MembershipPlanId; details: MembershipDetails; revision: number | null; published: boolean;
  courtDiscount: MembershipCourtDiscount | null;
  openPlayDiscount?: MembershipOpenPlayDiscount;
  legacyCourtRates?: { daytime: number | null; evening: number | null };
};

export function emptyMembershipDetails(id: MembershipPlanId): MembershipDetails {
  return {
    price_cents: 0,
    plan_name: membershipPlanLabels[id],
    price_period: id === "annual" ? "year" : "6 months",
    heading: "",
    introduction: "",
    validity: "",
    redemption: "",
    home_summary: "",
    benefits: [],
  };
}

export function isPublishedMembershipPlan(plan: MembershipPlan): plan is MembershipPlan & { revision: number } {
  return plan.published && plan.revision !== null;
}

function membershipCourtDiscountBenefits(plan: MembershipPlan): MembershipDetails["benefits"] {
  const discount = plan.courtDiscount;
  const icon = "wallet";
  if (discount) {
    if (!discount.enabled) return [];
    const amount = money(discount.amountCents / 100);
    const minimum = discount.minHours;
    return [{ icon, title: `${amount} off private court bookings`,
      description: `Save ${amount} once per private court booking of at least ${minimum} ${minimum === 1 ? "hour" : "hours"}, online or through an account-linked walk-in.` }];
  }

  return (["daytime", "evening"] as const).flatMap((period) => {
    const cap = plan.legacyCourtRates?.[period];
    return cap == null ? [] : [{ icon, title: `Up to ${money(cap / 100)} per ${period} court hour`,
      description: `Your member rate applies automatically to eligible ${period} hours when you book a private court online.` }];
  });
}

export function publishedMembershipDetails(plan: MembershipPlan): MembershipDetails {
  const discounts = membershipCourtDiscountBenefits(plan);
  const openPlay = plan.openPlayDiscount;
  if (openPlay?.enabled) {
    discounts.push({
      icon: "users",
      title: `Up to ${money(openPlay.amountCents / 100)} off open play`,
      description: `Save up to ${money(openPlay.amountCents / 100)} on one member pass per session. The discounted price is at least ${money(openPlay.floorCents / 100)}. Lower-priced sessions keep their regular rate.`,
    });
  }
  return { ...plan.details, benefits: [...discounts, ...plan.details.benefits] };
}
