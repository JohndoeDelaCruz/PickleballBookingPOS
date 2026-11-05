import type { Metadata } from "next";
import { Archivo_Black, Manrope, DM_Serif_Display } from "next/font/google";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { getSession } from "@/lib/data";
import "lenis/dist/lenis.css";
import "./globals.css";
import "./console.css";
import "./editorial.css";
import "./workspace.css";

const body = Manrope({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});
const display = Archivo_Black({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-display",
  display: "swap",
});
const serif = DM_Serif_Display({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-serif",
  display: "swap",
});
export const metadata: Metadata = {
  title: {
    default: "Rally Club — Good game. Good company.",
    template: "%s | Rally Club",
  },
  description:
    "Less screen time. More court time. Find your next pickleball game, reserve a court, and make a little time for good company.",
  icons: { icon: "/icon.svg" },
};
export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { user, staff } = await getSession();
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body
        className={`${body.variable} ${display.variable} ${serif.variable}`}
      >
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <Header signedIn={Boolean(user)} staff={staff} />
        {children}
        <Footer staff={staff} />
      </body>
    </html>
  );
}
