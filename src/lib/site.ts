/**
 * The public host, when one is known. `AUTH_DOMAIN` wins; on Vercel production the
 * project's production domain (e.g. `omnifolio.vercel.app`) is used, so a first deploy
 * needs no extra setting. Cloud Run exposes no such variable, so `deploy/gcp-setup.sh`
 * sets `AUTH_DOMAIN` to the service's host after the first deploy. Previews and local dev
 * return undefined and use the request host.
 */
export function publicHost(): string | undefined {
  if (process.env.AUTH_DOMAIN) return process.env.AUTH_DOMAIN.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (process.env.VERCEL_ENV === "production") return process.env.VERCEL_PROJECT_PRODUCTION_URL || undefined;
  return undefined;
}

/** True inside a Cloud Run container (set by the platform on every revision). */
export function onCloudRun(): boolean {
  return Boolean(process.env.K_SERVICE);
}

/** Base for absolute URLs in metadata (share previews, sitemap). */
export function siteUrl(): URL {
  const host = publicHost() ?? process.env.VERCEL_URL;
  if (host) return new URL(host.startsWith("localhost") || host.startsWith("127.") ? `http://${host}` : `https://${host}`);
  return new URL(`http://localhost:${process.env.PORT || 43127}`);
}
