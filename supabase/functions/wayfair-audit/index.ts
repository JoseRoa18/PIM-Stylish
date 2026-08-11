// Scheduled Wayfair audit — the server-side twin of the WayfairAuditCard's
// "run audit" button, so the wayfair channel_health snapshot stays fresh
// without anyone clicking. pg_cron calls this shortly BEFORE health-refresh,
// which then re-scores listing health against the new snapshot.
//
// Auth: x-cron-secret (pg_cron) or the service-role key (manual/testing).
// Deployed with --no-verify-jwt; this gate is the real check.
//
// Body: { supplier?: "CAN" | "USA", market?: string, limit?: number }

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Gentle on purpose: Wayfair rate-limits aggressively (the token endpoint
// especially). Two workers + honoring "Retry after Nms" keeps a full-catalog
// audit inside both Wayfair's quota and the function's wall clock.
const CONCURRENCY = 2;
const DEADLINE_MS = 320_000; // stop early and snapshot as partial past this

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function invokeFn(name: string, body: unknown = {}) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data?.error) throw new Error(data?.error ?? `${name} ${res.status}`);
  return data;
}

async function restSelect(pathAndQuery: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`select failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function restInsert(table: string, rows: unknown[]) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`insert ${table} failed: ${res.status} ${await res.text()}`);
}

// The full paced audit can run several minutes — far past the HTTP request
// window (pg_net gives it 10s; the gateway kills awaited handlers around
// 150s, which silently ate the first full run). So the request only starts
// the job: auth, kick off runAudit as a background task, answer 202. Pass
// {sync: true} (with a small limit) to await inline for testing.
async function runAudit(supplier: string, market: string | undefined, limit: number) {
  const startedAt = Date.now();
  try {

    const products = await restSelect("products?select=sku&order=category,sku");
    let skus: string[] = products.map((p: { sku: string }) => p.sku);

    // Wayfair's rate limit caps one run at roughly half the catalog, so runs
    // ROTATE: SKUs missing from the previous snapshot go first, and whatever
    // this run can't reach carries forward from that snapshot. Two cron runs
    // a day keep every SKU at most ~a day stale, and the published snapshot
    // is always full-catalog.
    const prevRows = await restSelect(
      "channel_health?channel=eq.wayfair&select=results&order=run_at.desc&limit=1",
    );
    const prevBySku = new Map<string, Record<string, unknown>>(
      (prevRows?.[0]?.results ?? []).map((r: { sku: string }) => [r.sku, r]),
    );
    skus = [
      ...skus.filter((s) => !prevBySku.has(s)),
      ...skus.filter((s) => prevBySku.has(s)),
    ].slice(0, limit === Infinity ? undefined : limit);

    type Row = { sku: string; changed: number; mapped: number; diff: Record<string, { changed: boolean }> };
    const rows: Row[] = [];
    const errors: { sku: string; message: string }[] = [];

    // One dry-run per SKU, honoring Wayfair's "Retry after Nms" instead of
    // burning the quota into a wall of errors (which is exactly what a naive
    // full-speed sweep did: 30 results, 287 rate-limits).
    async function auditSku(sku: string) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await invokeFn("wayfair-push-attributes", {
            sku, dryRun: true, validateOnly: true, supplier, market,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const wait = Number(msg.match(/Retry after (\d+)ms/i)?.[1]);
          const remaining = DEADLINE_MS - (Date.now() - startedAt);
          if (!Number.isFinite(wait) || attempt >= 2 || wait + 5_000 > remaining) throw err;
          await sleep(Math.min(wait + 1_000, 90_000));
        }
      }
    }

    let cursor = 0;
    async function worker() {
      while (cursor < skus.length && Date.now() - startedAt < DEADLINE_MS) {
        const sku = skus[cursor++];
        try {
          const res = await auditSku(sku);
          rows.push({
            sku,
            changed: res.changedCount ?? 0,
            mapped: res.updates ?? 0,
            diff: res.diff ?? {},
          });
        } catch (err) {
          errors.push({ sku, message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, skus.length) }, worker));

    // Merge: fresh results win; SKUs this run couldn't reach (deadline or
    // error) keep their previous result so the snapshot stays full-catalog.
    const freshBySku = new Map(rows.map((r) => [r.sku, r]));
    let carried = 0;
    for (const [sku, prev] of prevBySku) {
      if (freshBySku.has(sku)) continue;
      // Carry forward for unreached SKUs AND errored ones (stale beats blank).
      rows.push({
        sku,
        changed: (prev.changed as number) ?? 0,
        mapped: (prev.mapped as number) ?? 0,
        diff: Object.fromEntries(((prev.fields as string[]) ?? []).map((f) => [f, { changed: true }])),
      });
      carried += 1;
    }
    const freshCount = freshBySku.size;

    // Same snapshot shape the WayfairAuditCard persists, so Listing Health
    // and the card read cron runs and manual runs identically.
    const offenders = rows
      .filter((r) => r.changed > 0)
      .sort((a, b) => b.changed - a.changed)
      .slice(0, 10)
      .map((r) => ({
        sku: r.sku,
        changed: r.changed,
        fields: Object.entries(r.diff).filter(([, d]) => d.changed).slice(0, 4).map(([t]) => t),
      }));

    // After the merge, "errors" = SKUs with no result at all (neither fresh
    // nor carried) — what the card labels "not audited". Per-run failures
    // live in the report's error_groups.
    const uncovered = skus.length - rows.length;
    const snapshot = {
      channel: "wayfair",
      target: `${supplier}/${market ?? "default"}`,
      total: skus.length,
      in_sync: rows.filter((r) => r.changed === 0).length,
      with_diffs: rows.filter((r) => r.changed > 0).length,
      errors: uncovered,
      partial: uncovered > 0,
      top_offenders: offenders,
      results: rows.map((r) => ({
        sku: r.sku,
        changed: r.changed,
        fields: Object.entries(r.diff).filter(([, d]) => d.changed).map(([t]) => t),
      })),
    };
    await restInsert("channel_health", [snapshot]);

    // Group error messages so a systemic failure (rate limit, auth) is
    // readable from the report instead of hiding behind a count.
    const errorGroups = new Map<string, number>();
    for (const e of errors) {
      const key = e.message.slice(0, 120);
      errorGroups.set(key, (errorGroups.get(key) ?? 0) + 1);
    }
    const report = {
      ok: true,
      total: snapshot.total,
      fresh: freshCount,
      carried,
      in_sync: snapshot.in_sync,
      with_diffs: snapshot.with_diffs,
      uncovered,
      run_errors: errors.length,
      error_groups: Object.fromEntries([...errorGroups].sort((a, b) => b[1] - a[1]).slice(0, 5)),
      ms: Date.now() - startedAt,
    };
    console.log("wayfair-audit report:", JSON.stringify(report));
    return report;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[wayfair-audit] FAILED:", message);
    return { ok: false, error: message, ms: Date.now() - startedAt };
  }
}

Deno.serve(async (req) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  const providedSecret = req.headers.get("x-cron-secret");
  const auth = req.headers.get("authorization") ?? "";
  const authorized =
    (cronSecret && providedSecret === cronSecret) || auth === `Bearer ${SERVICE_KEY}`;
  if (!authorized) return json({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const supplier = body.supplier === "USA" ? "USA" : "CAN";
  const market = typeof body.market === "string" ? body.market : undefined;
  const limit = Number.isFinite(body.limit) ? Number(body.limit) : Infinity;

  const job = runAudit(supplier, market, limit);
  const g = globalThis as unknown as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } };
  if (body.sync === true || !g.EdgeRuntime?.waitUntil) {
    return json(await job);
  }
  g.EdgeRuntime.waitUntil(job);
  return json({ accepted: true, supplier, market: market ?? "default" }, 202);
});
