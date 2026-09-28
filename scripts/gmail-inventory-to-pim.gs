/**
 * Gmail → PIM: the Canada inventory workbook ("Stylish Inventory" .xlsx —
 * PART NUMBER, NAME, QUANTITY IN STOCK CANADA, ETA CAN) arrives in this
 * mailbox by email every day. This script finds the newest email carrying
 * it and hands the file to the PIM's `inventory-pull` function, which reads
 * it into product_inventory (market Canada). Same pattern as
 * gmail-price2spy-to-pim.gs.
 *
 * Setup (once, in the mailbox that receives the file):
 *   1. script.google.com → New project → paste this file → fill the three
 *      constants below (the PIM public key and INVENTORY_INBOUND_SECRET).
 *   2. Run `pullInventoryFromGmail` once by hand and grant Gmail access.
 *   3. Triggers (clock icon) → Add trigger → pullInventoryFromGmail →
 *      Time-driven → Day timer → e.g. 7am–8am (after the email lands).
 *      Hourly is fine too: a thread already loaded is labelled and skipped.
 *
 * The PIM accepts this call ONLY with the shared secret, and with it the
 * endpoint can do exactly one thing: load a Canada inventory workbook.
 * Nothing else in the PIM is reachable with it.
 */
const PIM_ENDPOINT = 'https://vcmizxflfjcpxeccezlc.supabase.co/functions/v1/inventory-pull';
const PIM_ANON_KEY = 'REPLACE_WITH_THE_PIM_PUBLIC_KEY';   // public key, given with the secret
const PIM_SECRET = 'REPLACE_WITH_THE_SECRET';            // INVENTORY_INBOUND_SECRET

// What the daily email looks like. Adjust the subject if the sender uses
// another one; the attachment must be the .xlsx itself.
const GMAIL_QUERY = 'has:attachment filename:xlsx subject:"Stylish Inventory" newer_than:3d -label:PIM-Inventory-Loaded';
const DONE_LABEL = 'PIM-Inventory-Loaded';

function pullInventoryFromGmail() {
  const threads = GmailApp.search(GMAIL_QUERY, 0, 10);
  let best = null;
  for (const thread of threads) {
    for (const message of thread.getMessages()) {
      for (const attachment of message.getAttachments()) {
        if (!/\.xlsx$/i.test(attachment.getName())) continue;
        if (!best || message.getDate() > best.date) best = { date: message.getDate(), attachment, thread };
      }
    }
  }
  if (!best) {
    Logger.log('No new inventory email (query: ' + GMAIL_QUERY + ').');
    return;
  }

  const payload = {
    mode: 'pull',
    market: 'ca',
    via: 'email',
    fileName: best.attachment.getName(),
    file: Utilities.base64Encode(best.attachment.getBytes()),
  };
  const res = UrlFetchApp.fetch(PIM_ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    headers: { apikey: PIM_ANON_KEY, 'x-inventory-secret': PIM_SECRET },
    muteHttpExceptions: true,
  });
  const text = res.getContentText();
  Logger.log(res.getResponseCode() + ' ' + text.slice(0, 600));

  let report = null;
  try { report = JSON.parse(text); } catch (e) { /* not JSON */ }
  const ca = report && report.markets ? report.markets.ca : null;
  if (res.getResponseCode() !== 200 || !ca || !ca.ok) {
    throw new Error('The PIM did not load "' + best.attachment.getName() + '": ' + ((ca && ca.error) || (report && report.error) || text.slice(0, 300)));
  }
  // Mark the thread so the next run does not load the same file again.
  const label = GmailApp.getUserLabelByName(DONE_LABEL) || GmailApp.createLabel(DONE_LABEL);
  best.thread.addLabel(label);
  Logger.log('Loaded ' + best.attachment.getName() + ' (' + best.date + '): ' + ca.matched + ' SKUs, ' + ca.inStock + ' in stock, ' + (ca.unmatched || []).length + ' not in the PIM.');
}
