import { getVenue } from "@/lib/data";
import { SettingsForm } from "@/components/settings-form";
export default async function SettingsPage() {
  const { venue, courtsReady } = await getVenue();
  return <SettingsForm initial={venue} courtsReady={courtsReady} />;
}
