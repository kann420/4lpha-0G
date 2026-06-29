import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { WalletProvider } from "@/components/providers/WalletProvider";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import "./globals.css";

// Runs synchronously before hydration to set the theme class on <html> from
// localStorage (defaulting to dark), preventing a flash of the wrong theme.
const themeInitScript = `(function(){try{var t=localStorage.getItem('4lpha-theme');if(t!=='light'&&t!=='dark'){t='dark';}var d=document.documentElement;d.classList.remove('dark','light');d.classList.add(t);d.style.colorScheme=t;}catch(e){document.documentElement.classList.add('dark');}})();`;

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "4lpha 0G",
  description:
    "AI-powered token intelligence and autonomous trading agents on 0G, with Smart Scan for fast risk-aware discovery.",
  icons: {
    icon: "/4lpha_logo.svg",
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
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-full flex flex-col">
        <WalletProvider>
          <ThemeProvider>{children}</ThemeProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
