import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "API Watchdog", description: "Plataforma de monitoreo de APIs" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="es"><body>{children}</body></html>;
}
