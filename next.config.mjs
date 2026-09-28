/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /**
   * `postgres` (and its type-serialiser table) MUST NOT be bundled into the server chunk.
   * When webpack/turbopack inlines the driver, its parameter type inference loses the
   * `Date` -> `timestamptz` serializer, so any query with a `Date` parameter crashes with
   *   TypeError: The "string" argument must be of type string or an instance of Buffer
   *   or ArrayBuffer. Received an instance of Date
   * (thrown from postgres/src/bytes.js `str()` -> Buffer.byteLength). Loading the driver as
   * a real runtime dependency fixes every query that binds a timestamp.
   * The `postgres` module is copied into `.next/standalone/node_modules` by the build script,
   * so the standalone artifact resolves it at runtime too.
   */
  serverExternalPackages: ["postgres"],
};

export default nextConfig;
