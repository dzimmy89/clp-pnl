import { ImageResponse } from "next/og";
import { SITE_NAME, SITE_TAGLINE } from "@/components/brand";

export const alt = `${SITE_NAME}: ${SITE_TAGLINE}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 80,
          background: "#0a0b0e",
          color: "#eceef3",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <svg width="88" height="88" viewBox="0 0 64 64">
            <rect width="64" height="64" rx="14" fill="#111318" />
            <circle cx="32" cy="32" r="17" fill="none" stroke="#e2b54a" strokeWidth="7" />
            <circle cx="32" cy="32" r="5" fill="#5b93ff" />
          </svg>
          <div style={{ fontSize: 56, fontWeight: 700 }}>{SITE_NAME}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ fontSize: 84, fontWeight: 700, color: "#e2b54a", lineHeight: 1.05 }}>{`${SITE_TAGLINE}.`}</div>
          <div style={{ fontSize: 36, color: "#8c93a3" }}>
            Lending positions and spot holdings across EVM, Solana and NEAR.
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 28, color: "#5b93ff" }}>
          {["Aave", "Kamino", "Hyperlend", "Venus", "Rhea", "Alpend"].join("  ·  ")}
        </div>
      </div>
    ),
    size,
  );
}
