import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#0a0b0e" }}>
        <svg width="180" height="180" viewBox="0 0 64 64">
          <circle cx="32" cy="32" r="17" fill="none" stroke="#e2b54a" strokeWidth="7" />
          <circle cx="32" cy="32" r="5" fill="#5b93ff" />
        </svg>
      </div>
    ),
    size,
  );
}
