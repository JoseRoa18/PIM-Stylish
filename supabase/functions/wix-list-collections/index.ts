// Lists all Wix Stores collections (= "categories" in the new Wix UI).
//
// The UI uses these to render the multi-select picker on the Wix
// syndication card. They change rarely, so the client can cache the result.
//
// Required secrets:
//   WIX_API_KEY
//   WIX_SITE_ID

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

interface WixCollection {
  id: string;
  name: string;
}

// Standard GUID format. Wix's built-in "All Products" virtual collection has a
// malformed id (38+ chars) and can't be modified via API — exclude it.
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  console.log(`[wix-collections] ${req.method} ${req.url}`);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const WIX_API_KEY = Deno.env.get("WIX_API_KEY");
    const WIX_SITE_ID = Deno.env.get("WIX_SITE_ID");

    if (!WIX_API_KEY || !WIX_SITE_ID) {
      return new Response(
        JSON.stringify({ error: "Missing WIX_API_KEY or WIX_SITE_ID secret." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const all: WixCollection[] = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const resp = await fetch("https://www.wixapis.com/stores/v1/collections/query", {
        method: "POST",
        headers: {
          "Authorization": WIX_API_KEY,
          "wix-site-id": WIX_SITE_ID,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: { paging: { limit, offset } } }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Wix collections ${resp.status}: ${text}`);
      }
      const data = await resp.json();
      const batch: WixCollection[] = (data.collections ?? [])
        .filter((c: { id: string }) => GUID_RE.test(c.id))
        .map((c: { id: string; name?: string }) => ({ id: c.id, name: c.name ?? "(unnamed)" }));
      all.push(...batch);

      const total = data.totalResults ?? data.metadata?.count ?? all.length;
      offset += batch.length;
      if (batch.length === 0 || offset >= total) break;
    }

    all.sort((a, b) => a.name.localeCompare(b.name));

    return new Response(
      JSON.stringify({ collections: all }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    let message: string;
    if (err instanceof Error) message = err.message;
    else if (err && typeof err === "object") {
      message = (err as Record<string, unknown>).message as string ?? JSON.stringify(err);
    } else message = String(err);
    console.error(`[wix-collections] FAILED:`, message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
