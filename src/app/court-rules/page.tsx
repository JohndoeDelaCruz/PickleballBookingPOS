import type { Metadata } from "next";
import Link from "next/link";
import {
  Clock3,
  Users,
  Trophy,
  Footprints,
  CloudRain,
  ArrowUpRight,
} from "lucide-react";
import { getVenue } from "@/lib/data";
import {
  equipmentPackageLabel,
  money,
  openPlayCapacityLabel,
} from "@/lib/booking";

export const metadata: Metadata = {
  title: "Court rules",
  description:
    "Court time, player capacity, equipment rental, etiquette, weather, and safety rules at Rally Club.",
};

export default async function CourtRulesPage() {
  const { venue } = await getVenue();
  const sections = [
    {
      icon: Clock3,
      title: "Court time",
      rules: [
        "Please arrive 10 minutes before your scheduled booking.",
        "Court reservations are hourly. Kindly start and finish on time.",
        "Once your booking ends, please leave the court for the next players.",
        "If the court is available, you may start up to 10 minutes early.",
        "If the next booking is a no-show, you may continue for 10 minutes only. After that, please book an extension, subject to availability.",
      ],
    },
    {
      icon: Users,
      title: "Court capacity",
      rules: [
        venue.schedule_config
          ? "Private bookings follow the player limit shown for the selected court time."
          : `Maximum of ${venue.private_court_capacity} players per court for a private booking.`,
        ...(venue.schedule_config
          ? [
              "Open-play capacity applies separately to each session. Check the selected session's player limit before booking. Players share the active courts and rotate between games.",
            ]
          : venue.open_play_enabled
            ? [
                `Open play: ${openPlayCapacityLabel(venue.open_play_capacity)}. Players share the courts and rotate between games.`,
              ]
            : []),
      ],
    },
    {
      icon: Trophy,
      title: "Equipment rental",
      rules: [
        `${money(venue.equipment_rental_price)} per paddle, per session. Each rental set includes ${equipmentPackageLabel(venue.equipment_ball_count)}.`,
        "Please return all borrowed equipment after use.",
        "A ₱150 replacement fee will be charged for intentionally damaged or lost paddles.",
      ],
    },
    {
      icon: Footprints,
      title: "Court etiquette",
      rules: [
        "Wear proper athletic shoes.",
        "Keep the court clean. Please dispose of trash properly.",
        "No smoking or alcoholic drinks inside the court.",
        "Respect other players, staff, and officials.",
        "Use appropriate language and practice good sportsmanship.",
        "Supervise children at all times.",
      ],
    },
    {
      icon: CloudRain,
      title: "Weather & safety",
      rules: [
        "Play at your own risk.",
        "Management may suspend play due to rain or unsafe court conditions.",
        "Report any accidents or damaged equipment to staff immediately.",
      ],
    },
  ];
  return (
    <main id="main" className="container rules-page">
      <div className="page-heading">
        <span className="eyebrow">RALLY PICKLEBALL COURT</span>
        <h1>COURT RULES.</h1>
        <p>
          Welcome! Let’s keep the court safe, fun, and enjoyable for everyone.
        </p>
      </div>
      <div className="rules-layout">
        <nav className="rules-nav panel" aria-label="Court rules sections">
          {sections.map(({ title }) => (
            <a
              key={title}
              href={`#${title.toLowerCase().replace(/[^a-z]+/g, "-")}`}
            >
              {title}
            </a>
          ))}
        </nav>
        <div className="rules-sections">
          {sections.map(({ icon: Icon, title, rules }) => (
            <section
              className="panel rules-section"
              key={title}
              id={title.toLowerCase().replace(/[^a-z]+/g, "-")}
            >
              <h2>
                <Icon size={24} aria-hidden="true" />
                {title}
              </h2>
              <ul>
                {rules.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
            </section>
          ))}
          <div className="rules-signoff">
            <h2>Play fair. Play safe. Have fun!</h2>
            <p>
              Thank you for choosing Rally Club Court. We hope you enjoy
              every game!
            </p>
            <Link href="/book" className="button button-dark">
              Find your court <ArrowUpRight size={18} />
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
