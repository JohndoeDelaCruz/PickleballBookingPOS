import Link from "next/link";
import Image from "next/image";
import { ArrowDown, ArrowUpRight } from "lucide-react";
import { getVenue } from "@/lib/data";
import { formatHour } from "@/lib/booking";
import { LandingMotion } from "@/components/landing-motion";
import {
  ClubMarquee,
  CourtsideJournal,
  PlaySelector,
  ReservationLauncher,
} from "@/components/editorial-interactions";

export default async function Home() {
  const { venue, ready } = await getVenue();
  return (
    <LandingMotion>
      <section className="editorial-opening" aria-labelledby="editorial-title">
        <div className="club-hero">
          <div className="hero-photo">
            <Image
              className="hero-image"
              src="/images/rally-courts-v2.webp"
              alt="Two pickleball players facing each other across the net on a tropical blue court"
              fill
              priority
              sizes="(max-width: 600px) 1200px, (max-width: 1100px) 1600px, 100vw"
            />
          </div>
          <div className="hero-shade" aria-hidden="true" />
          <div className="hero-content">
            <p className="hero-kicker">PICKLEBALL, WITH A SOCIAL SIDE.</p>
            <h1 className="hero-title" id="editorial-title">
              <span className="title-mask">
                <span data-title-word="">Same time</span>
              </span>{" "}
              <span className="title-mask">
                <em data-title-word="">tomorrow?</em>
              </span>
            </h1>
            <div className="hero-deck">
              <div className="hero-actions">
                <a href="#reserve" className="hero-reserve-link">
                  Reserve a court <ArrowUpRight size={20} />
                </a>
                <a href="#play" className="hero-explore-link">
                  Find your game <ArrowDown size={18} />
                </a>
              </div>
            </div>
          </div>
        </div>
        <div className="hero-reservation" id="reserve">
          <ReservationLauncher />
        </div>
      </section>
      <div className="editorial-intro" data-slide-group="left">
        <span className="editorial-label">
          COME AS YOU ARE.{" "}
          <br />
          LEAVE WITH A GOOD STORY.
        </span>
        <p>
          A few good rallies can
          <br />
          change your whole day.
        </p>
        <Link href="/book" aria-label="Explore court reservations">
          <ArrowUpRight size={30} />
        </Link>
      </div>
      <ClubMarquee />
      <PlaySelector
        courtRate={venue.hourly_rate ?? 100}
        openRate={venue.open_play_price}
        ready={ready}
        scheduleConfigured={Boolean(venue.schedule_config)}
      />
      <section className="club-manifesto" id="club">
        <div className="manifesto-text">
          <h2 data-slide-group="left">
            {["For the game.", "For the people.", "For the", "good of it."].map(
              (line, i) => (
                <span
                  className={`manifesto-word ${i === 3 ? "manifesto-last" : ""}`}
                  key={line}
                >
                  {line}
                </span>
              ),
            )}
          </h2>
          <div className="manifesto-copy" data-slide="left">
            <span>THIS IS RALLY.</span>
            <p>
              A place to put your phone down, pick a paddle up, and feel a
              little more like yourself. First game or fiftieth, there’s always
              room for one more.
            </p>
            <Link href="/book?play=open">
              Come find your people <ArrowUpRight size={19} />
            </Link>
          </div>
        </div>
        <div className="manifesto-image" data-slide="right">
          <Image
            src="/images/rally-community.webp"
            alt="Two friends sharing a moment after their pickleball match"
            fill
            sizes="(max-width: 750px) 100vw, 47vw"
          />
          <div>
            <span>THE BEST PART?</span>
            <strong>
              The people
              <br />
              you play with.
            </strong>
          </div>
        </div>
      </section>
      <CourtsideJournal />
      <section className="club-finish" id="visit">
        <div className="finish-topline">
          <span className="editorial-label">
            LESS “WE SHOULD.” MORE “SEE YOU THERE.”
          </span>
          <span>YOUR NEXT GOOD GAME IS WAITING.</span>
        </div>
        <div className="finish-call">
          <h2 data-slide="left">
            See you
            <br />
            out there.
          </h2>
          <Link
            href="/book"
            className="finish-arrow"
            data-slide="right"
            aria-label="Book your next court session"
          >
            <ArrowUpRight strokeWidth={1} size={100} />
          </Link>
        </div>
        <div className="finish-information" data-slide-group="up">
          <div>
            <span>THE PLACE</span>
            <p>
              {venue.address || "Your venue location, coming soon."}
              {venue.city && (
                <>
                  <br />
                  {venue.city}
                </>
              )}
            </p>
            {venue.address && (
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${venue.name} ${venue.address} ${venue.city}`)}`}
                target="_blank"
                rel="noreferrer"
              >
                Get directions <ArrowUpRight size={14} />
              </a>
            )}
          </div>
          <div>
            <span>THE TIME</span>
            <p>
              {venue.schedule_config
                ? "Find your session in the calendar."
                : `${formatHour(venue.opening_hour ?? 6)} — ${formatHour(venue.closing_hour ?? 22)}`}
            </p>
            {!ready && <small>Sample hours for presentation</small>}
          </div>
          <div>
            <span>THE PLAN</span>
            <p>
              Reserve. Pay by GCash.
              <br />
              We verify. You play.
            </p>
            <Link href="/book">
              Make it a date <ArrowUpRight size={14} />
            </Link>
          </div>
          {(venue.email || venue.phone) && (
            <div>
              <span>SAY HELLO</span>
              {venue.email && (
                <a href={`mailto:${venue.email}`}>{venue.email}</a>
              )}
              {venue.phone && <a href={`tel:${venue.phone}`}>{venue.phone}</a>}
            </div>
          )}
        </div>
      </section>
    </LandingMotion>
  );
}
