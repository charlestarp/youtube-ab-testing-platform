import type { Metadata } from "next";
import { Inter, Baloo_2 } from "next/font/google";
import { Providers } from "./providers";
import "./globals.css";

// Body face (stand-in for Serial B Neue). Swap to the licensed face here.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

// Display face (stand-in for Cusion). Swap to the licensed face here.
const baloo = Baloo_2({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-baloo",
  display: "swap",
});

export const metadata: Metadata = {
  title: "YT Testing",
  description: "YouTube A/B testing, insights, and analytics for Toni and Ryan",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} ${baloo.variable} antialiased`} suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
