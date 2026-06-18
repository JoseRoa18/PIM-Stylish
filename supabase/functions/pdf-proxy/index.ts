// CORS proxy for Dropbox-hosted PDFs.
//
// Dropbox share links (www.dropbox.com/...?raw=1) 302-redirect to the content
// host (dl.dropboxusercontent.com). The content host allows CORS, but the
// www.dropbox.com redirect does NOT — so a browser fetch (and therefore PDF.js)
// fails with "TypeError: Failed to fetch". This function fetches the file
// server-side (where CORS doesn't apply, redirects are followed transparently)
// and streams it back with permissive CORS headers so PDF.js can render it.
//
// Request:  GET /pdf-proxy?url=<dropbox url>
// Deploy with JWT verification OFF so the browser can fetch it directly:
//   supabase functions deploy pdf-proxy --no-verify-jwt

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, range",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// Only proxy Dropbox URLs — prevents this from being used as an open proxy (SSRF).
const ALLOWED = /^https:\/\/(www\.)?dropbox\.com\/|^https:\/\/[\w-]+\.dl\.dropboxusercontent\.com\//i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const target = new URL(req.url).searchParams.get("url");
  if (!target) {
    return new Response(JSON.stringify({ error: "Missing url parameter." }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!ALLOWED.test(target)) {
    return new Response(JSON.stringify({ error: "Only Dropbox URLs are allowed." }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // Follow the redirect chain server-side (no CORS server-side).
    const upstream = await fetch(target, { redirect: "follow" });
    if (!upstream.ok || !upstream.body) {
      return new Response(
        JSON.stringify({ error: `Upstream responded ${upstream.status}.` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Stream the bytes back. We don't forward Range requests, so PDF.js falls
    // back to a full download (fine for spec sheets / manuals).
    return new Response(upstream.body, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/pdf",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[pdf-proxy] FAILED:", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
