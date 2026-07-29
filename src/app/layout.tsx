import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { AppShell } from "@/components/app-shell";
import { ConfirmDialogProvider } from "@/components/ui/confirm-dialog";
import { PortalAccessGate } from "@/components/portal-access-gate";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SciManage - 科研项目管理",
  description: "单细胞测序与空间转录组科研项目管理系统",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col md:flex-row bg-background text-foreground">
        <ConfirmDialogProvider>
          <Providers>
            <PortalAccessGate>
              <AppShell>{children}</AppShell>
            </PortalAccessGate>
          </Providers>
        </ConfirmDialogProvider>
      </body>
    </html>
  );
}
