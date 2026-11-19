import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { PaddleStackLive } from "@/components/paddle-stack";
import styles from "@/components/paddle-stack.module.css";

export const metadata: Metadata = {
  title: "Open Play Live Board",
  robots: { index: false, follow: false },
};

export default async function PublicPaddleStack({
  params,
}: {
  params: Promise<{ session: string }>;
}) {
  const { session } = await params;
  if (!z.uuid().safeParse(session).success) notFound();
  return (
    <main id="main" className={`container ${styles.publicBoard}`}>
      <h1>Open Play Live Board</h1>
      <PaddleStackLive session={session} />
    </main>
  );
}
