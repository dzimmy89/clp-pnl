"use client";

/** Replaces the root layout when it fails, so it carries its own styles. */
export default function GlobalError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#0a0b0e",
          color: "#eceef3",
          fontFamily: "system-ui, sans-serif",
          textAlign: "center",
          padding: 16,
        }}
      >
        <title>Something went wrong · Omnifolio</title>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 600 }}>Something went wrong</h1>
          <p style={{ color: "#8c93a3" }}>Omnifolio hit an error. Try again in a moment.</p>
          <button
            type="button"
            onClick={() => retry()}
            style={{ marginTop: 12, padding: "8px 18px", borderRadius: 999, border: 0, background: "#e2b54a", color: "#14110a", fontWeight: 600, cursor: "pointer" }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
