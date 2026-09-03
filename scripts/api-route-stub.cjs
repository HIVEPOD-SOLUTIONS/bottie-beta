/**
 * api-route-stub.cjs  — Webpack loader (CommonJS)
 *
 * Replaces every API route file with a minimal stub that satisfies
 * Next.js `output: 'export'` requirements.  The real handlers live on the
 * deployed Vercel server; this stub only exists so the build doesn't fail.
 *
 * Configured in next.config.ts when NEXT_EXPORT=1 (Android APK builds).
 */
module.exports = function apiRouteStubLoader() {
  // Mark the loader as cacheable so Webpack doesn't re-run it unnecessarily.
  this.cacheable && this.cacheable();

  // Return valid ESM that Next.js static-export machinery understands:
  //  • dynamic = 'force-static'  → tells Next.js this route is static-safe
  //  • generateStaticParams()    → returns [] so no static files are emitted
  //  • HTTP method stubs         → prevent "handler not found" build errors
  return [
    'export const dynamic = "force-static";',
    'export const revalidate = false;',
    'export async function generateStaticParams() { return []; }',
    'export async function GET()     { return new Response("", { status: 404 }); }',
    'export async function POST()    { return new Response("", { status: 404 }); }',
    'export async function PUT()     { return new Response("", { status: 404 }); }',
    'export async function DELETE()  { return new Response("", { status: 404 }); }',
    'export async function PATCH()   { return new Response("", { status: 404 }); }',
    'export async function HEAD()    { return new Response("", { status: 404 }); }',
    'export async function OPTIONS() { return new Response("", { status: 404 }); }',
  ].join('\n');
};
