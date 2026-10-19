import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Los Canarios | CRM operativo",
  description: "Gestión de ventas, planta, despacho y cartera.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
