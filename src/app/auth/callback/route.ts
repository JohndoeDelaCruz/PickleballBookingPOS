import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { authCallbackDestination } from "@/lib/auth-callback";
import { siteOrigin } from "@/lib/site-url";
export async function GET(request: NextRequest) {
  const origin = siteOrigin(request.url, {
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
    host: request.headers.get("host"),
  });
  const supabase = await createClient();
  const destination = await authCallbackDestination(
    request.nextUrl.searchParams,
    supabase,
  );
  return NextResponse.redirect(new URL(destination, origin));
}
