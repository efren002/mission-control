import type { Metadata } from "next";

import { ApplicationProviders } from "@/providers/application-providers";

import "./globals.css";

export const metadata: Metadata = {
  title: "Mission Control",
  description: "Local AI software company command center",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="font-mono antialiased">
        <ApplicationProviders>{children}</ApplicationProviders>
      </body>
    </html>
  );
}
