import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "API Watchdog", description: "API monitoring platform" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
