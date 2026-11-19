import { CalendarDays, Check, Gift, GraduationCap, Heart, Trophy, Users, Wallet } from "lucide-react";
import type { membershipBenefitIcons } from "@/lib/membership";

export const benefitIcons = {
  trophy: { Icon: Trophy, label: "Trophy" },
  wallet: { Icon: Wallet, label: "Wallet" },
  users: { Icon: Users, label: "Group" },
  calendar: { Icon: CalendarDays, label: "Calendar" },
  check: { Icon: Check, label: "Checkmark" },
  heart: { Icon: Heart, label: "Heart" },
  gift: { Icon: Gift, label: "Gift" },
  coaching: { Icon: GraduationCap, label: "Coaching" },
} satisfies Record<(typeof membershipBenefitIcons)[number], { Icon: typeof Trophy; label: string }>;
