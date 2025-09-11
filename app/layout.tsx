import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Mercury Research - AI-Powered Financial Research Platform",
  description:
    "AI-powered deep research platform for Investment Advisors, Financial Analysts, and Portfolio Managers. Get comprehensive financial insights with institutional-grade analysis.",
  keywords:
    "financial research, investment analysis, wealth management, portfolio management, AI research, financial advisors",
  openGraph: {
    title: "Mercury Research - AI-Powered Financial Research",
    description:
      "AI-powered deep research platform for Investment Advisors, Financial Analysts, and Portfolio Managers.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Mercury Research - AI-Powered Financial Research",
    description:
      "AI-powered deep research platform for Investment Advisors, Financial Analysts, and Portfolio Managers.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        suppressHydrationWarning={true}
        className={cn(
          "min-h-screen bg-background font-sans antialiased",
          inter.variable
        )}
      >
        <main className="">{children}</main>
      </body>
    </html>
  );
}
