import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ConvexClientProvider } from "@/providers/convex-client-provider";
import { Toaster } from "sonner"
import { ModalProvider } from "@/providers/modal-provider";
import { I18nProvider } from "@/providers/i18n-provider";
import { Suspense } from "react";
import { Loading } from "@/components/auth/loading";
import { LanguageAwareHtml } from "@/components/language-aware-html";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "rimo",
  description: "Визуальный workspace для учебы и работы.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <I18nProvider>
          <Suspense fallback={<Loading/>}>
            <ConvexClientProvider>
                <LanguageAwareHtml>
                  <Toaster />
                  <ModalProvider />
                  {children}
                </LanguageAwareHtml>
            </ConvexClientProvider>
          </Suspense>
        </I18nProvider>
      </body>
    </html>
  );
}
