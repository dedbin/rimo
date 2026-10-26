import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Toaster } from "sonner"
import { ModalProvider } from "@/providers/modal-provider";
import { I18nProvider } from "@/providers/i18n-provider";
import { Suspense } from "react";
import { Loading } from "@/components/auth/loading";
import { LanguageAwareHtml } from "@/components/language-aware-html";

const geistSans = localFont({
  src: "../node_modules/@fontsource/geist/files/geist-latin-400-normal.woff2",
  variable: "--font-geist-sans",
});

const geistMono = localFont({
  src: "../node_modules/@fontsource/geist-mono/files/geist-mono-latin-400-normal.woff2",
  variable: "--font-geist-mono",
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
    <html lang="ru">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <I18nProvider>
          <Suspense fallback={<Loading/>}>
                <LanguageAwareHtml>
                  <Toaster />
                  <ModalProvider />
                  {children}
                </LanguageAwareHtml>
          </Suspense>
        </I18nProvider>
      </body>
    </html>
  );
}
