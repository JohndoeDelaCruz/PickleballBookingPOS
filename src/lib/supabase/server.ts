import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const store = await cookies();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const userEndpoint = `${supabaseUrl.replace(/\/+$/, "")}/auth/v1/user`;
  return createServerClient(
    supabaseUrl,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      global: {
        fetch(input, init) {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (url === userEndpoint && !init?.signal) {
            // Make an Auth retry reach Supabase instead of reusing a failed GET in this render.
            return fetch(input, { ...init, signal: new AbortController().signal });
          }
          return fetch(input, init);
        },
      },
      cookies: {
        getAll: () => store.getAll(),
        setAll: (items) => {
          try {
            items.forEach(({ name, value, options }) =>
              store.set(name, value, options),
            );
          } catch {
            /* Server Components cannot set cookies; proxy refreshes sessions. */
          }
        },
      },
    },
  );
}
