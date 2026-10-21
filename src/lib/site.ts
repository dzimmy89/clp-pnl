/**
 * The public host, when one is known: `AUTH_DOMAIN`. Cloud Run exposes no variable with the
 * service's host, so `deploy/gcp-setup.sh` sets `AUTH_DOMAIN` to it after the first deploy.
 * Local dev returns undefined and uses the request host.
 */
export function publicHost(): string | undefined {
  if (process.env.AUTH_DOMAIN) return process.env.AUTH_DOMAIN.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return undefined;
}

/** True inside a Cloud Run container (set by the platform on every revision). */
export function onCloudRun(): boolean {
  return Boolean(process.env.K_SERVICE);
}

/** Base for absolute URLs in metadata (share previews, sitemap). */
export function siteUrl(): URL {
  const host = publicHost();
  if (host) return new URL(host.startsWith("localhost") || host.startsWith("127.") ? `http://${host}` : `https://${host}`);
  return new URL(`http://localhost:${process.env.PORT || 43127}`);
}
