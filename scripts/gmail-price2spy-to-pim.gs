/**
 * Stylish PIM — Price2Spy report forwarder (Google Apps Script).
 *
 * Runs inside the Gmail account that receives the daily Price2Spy matrix
 * reports (usa-p2s-pricing-report-YYYY-MM-DD.xlsx / canada-…). Once a day it
 * finds the unprocessed report emails, posts ONLY the newest report per
 * market (usa / canada) to the PIM, and labels the emails so they are never
 * sent twice.
 *
 * Setup (5 minutes, done once by the mailbox owner):
 *   1. script.google.com → New project → paste this file → set PIM_SECRET below.
 *   2. Run `sendPrice2SpyReports` once from the editor and accept the
 *      permissions (Gmail read + external requests).
 *   3. Triggers (clock icon) → Add trigger → sendPrice2SpyReports,
 *      Time-driven, Day timer, 7am–8am.
 *
 * Nothing else in the PIM is reachable with this secret: the endpoint only
 * accepts Price2Spy report files with it.
 */

const PIM_ENDPOINT = 'https://vcmizxflfjcpxeccezlc.supabase.co/functions/v1/where-to-buy-audit';
const PIM_ANON_KEY = 'REPLACE_WITH_THE_PIM_PUBLIC_KEY';   // public key, given with the secret
const PIM_SECRET = 'REPLACE_WITH_THE_SECRET';            // P2S_INBOUND_SECRET
const LABEL_DONE = 'PIM/price2spy-imported';
const LOOKBACK_DAYS = 5;

function sendPrice2SpyReports() {
  const label = GmailApp.getUserLabelByName(LABEL_DONE) || GmailApp.createLabel(LABEL_DONE);
  const query = `has:attachment filename:xlsx newer_than:${LOOKBACK_DAYS}d -label:${LABEL_DONE.replace('/', '-')} (filename:p2s-pricing-report OR subject:price2spy)`;
  const threads = GmailApp.search(query, 0, 20);
  Logger.log(`${threads.length} thread(s) to check`);

  // Collect every report attachment, then keep only the NEWEST per market
  // (usa / canada) by the date in the file name. Older ones are labeled as
  // done without being sent — the PIM would ignore them anyway.
  const newest = {};
  for (const thread of threads) {
    for (const message of thread.getMessages()) {
      for (const att of message.getAttachments()) {
        const name = att.getName();
        const m = name.match(/^(usa|canada)-p2s-pricing-report-(\d{4}-\d{2}-\d{2})/i);
        if (!m || !/\.xlsx$/i.test(name)) continue;
        const market = m[1].toLowerCase();
        if (!newest[market] || m[2] > newest[market].date) newest[market] = { date: m[2], name, att };
      }
    }
  }
  const files = Object.values(newest).map((f) => ({ name: f.name, base64: Utilities.base64Encode(f.att.getBytes()) }));
  if (!files.length) { Logger.log('No new Price2Spy reports'); return; }

  const res = UrlFetchApp.fetch(PIM_ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: PIM_ANON_KEY, 'x-p2s-secret': PIM_SECRET },
    payload: JSON.stringify({ mode: 'p2s-file', files }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  Logger.log(`${files.map((f) => f.name).join(', ')} -> HTTP ${code}: ${res.getContentText().slice(0, 400)}`);
  if (code === 200) for (const thread of threads) thread.addLabel(label);
}
