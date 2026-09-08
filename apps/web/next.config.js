/** @type {import('next').NextConfig} */

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@aurapay/shared'],
  // `/v1/*` is proxied in middleware.ts rather than here, so the API can see the
  // host the browser used (see the comment there). Cookies stay same-origin and no
  // API secret ever needs to exist in frontend code.
};

export default nextConfig;
