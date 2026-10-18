import { SITE_NAME } from "@/components/brand";

/** TON Connect manifest: wallets show this name and icon when asked to connect. */
export function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return Response.json(
    { url: origin, name: SITE_NAME, iconUrl: `${origin}/apple-icon` },
    { headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=3600" } },
  );
}
