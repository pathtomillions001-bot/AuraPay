import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { SessionProvider } from '../components/SessionProvider';

export const metadata: Metadata = {
  title: 'AuraPay — settle crypto as local money',
  description:
    'Send USDT, USDC, BTC or ETH; your recipient is paid in shillings on the rail they already use. Prices are locked while you confirm.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: '#05070a', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-KE">
      <body className="relative min-h-screen font-sans antialiased">
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
