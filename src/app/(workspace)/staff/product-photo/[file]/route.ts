import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const headers = { "Cache-Control": "private, no-store" };
  const { file } = await params;
  const version = z.uuid().safeParse(file.endsWith(".jpg") ? file.slice(0, -4) : "");
  if (!version.success) return new Response(null, { status: 404, headers });

  const db = await createClient();
  const { data, error } = await db.rpc("pos_product_photo", { p_version: version.data });
  if (error || typeof data !== "string" || !data) return new Response(null, { status: 404, headers });

  return new Response(new Uint8Array(Buffer.from(data, "base64")), {
    headers: { ...headers, "Content-Type": "image/jpeg", "X-Content-Type-Options": "nosniff" },
  });
}
