/** @type {import('next').NextConfig} */
const nextConfig = {
  // node:sqlite is a built-in — keep server code from being over-bundled
  serverExternalPackages: [],
};
export default nextConfig;
