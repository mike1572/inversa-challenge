import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

// Plex over a neutral grotesque: it was drawn for technical documentation, so
// it stays legible at 10-11px where this interface lives, and the mono cut
// matches it exactly — which matters when numbers sit inline with prose.
const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});
const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Smoke & Breath",
  description:
    "Which fires are driving the air people are breathing, and where is the smoke headed? " +
    "Live satellite fire detections, wind and ground PM2.5 across North America.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="bg-base h-full overflow-hidden">{children}</body>
    </html>
  );
}
