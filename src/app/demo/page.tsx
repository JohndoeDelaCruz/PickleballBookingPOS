import type { Metadata } from "next";
import { ClubConsole } from "@/components/club-console";
export const metadata: Metadata = {
  title: "Client presentation",
  robots: { index: false, follow: false },
};
export default function DemoPage() {
  return <ClubConsole demo />;
}
