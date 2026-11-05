export function siteOrigin(
  requestUrl: string,
  { siteUrl, host }: { siteUrl?: string; host?: string | null } = {},
) {
  const url = new URL(siteUrl || requestUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("The site URL must be an HTTP or HTTPS website address.");

  const isBindAddress = (hostname: string) =>
    hostname === "0.0.0.0" || hostname === "[::]";

  // Next can build request.url from the listening address rather than the browser's host.
  if (
    !siteUrl &&
    isBindAddress(url.hostname) &&
    host &&
    !/[\\/\s@?#]/.test(host)
  ) {
    try {
      const browserUrl = new URL(`${url.protocol}//${host}`);
      if (!isBindAddress(browserUrl.hostname)) url.host = browserUrl.host;
    } catch {
      // An unusable Host header falls back to localhost for local development.
    }
  }
  if (isBindAddress(url.hostname)) url.hostname = "localhost";
  return url.origin;
}

export function authCallbackUrl(origin: string, next?: string) {
  const url = new URL("/auth/callback", siteOrigin(origin));
  if (next) url.searchParams.set("next", next);
  return url.toString();
}
