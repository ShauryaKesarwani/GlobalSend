import type { Metadata } from "next";
import { GoogleAnalytics } from "@next/third-parties/google";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "GlobalSend — Peer-to-peer file transfer",
    template: "%s | GlobalSend",
  },
  description:
    "GlobalSend is a peer-to-peer technology ecosystem. Send files directly between browsers with fast WebRTC transfers and no file uploads to a server.",
  applicationName: "GlobalSend",
  keywords: ["GlobalSend", "P2P", "file sharing", "file transfer", "WebRTC"],
  openGraph: {
    title: "GlobalSend — Peer-to-peer file transfer",
    description:
      "GlobalSend builds peer-to-peer products. Start with fast, direct browser-to-browser file transfers.",
    siteName: "GlobalSend",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "GlobalSend — Peer-to-peer file transfer",
    description:
      "GlobalSend builds peer-to-peer products. Start with fast, direct browser-to-browser file transfers.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster position="top-center" />
      </body>
      <GoogleAnalytics gaId="G-B5PK9PMVZB" />
    </html>
  );
}
