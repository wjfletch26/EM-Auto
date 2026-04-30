/**
 * Standard outbound HTML signature for Deaton Engineering outreach.
 * Matches the company card (David Knieriem) used in client email.
 * Inserted by the send engine before the CAN-SPAM footer so every send path gets it.
 */

/** HTML block (uses <br> so stripHtml in send-engine preserves line breaks in the text part). */
export const OUTBOUND_SIGNATURE_HTML = `
<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #111111; line-height: 1.45; margin-top: 18px;">
David Knieriem<br>
President<br>
Deaton Engineering, Inc.<br>
<strong><em>Design. Prototype. Automate. Scaleup. De-risk.</em></strong><br>
512-921-9221 📞 cell<br>
<a href="mailto:dknieriem@deatonengineering.com" style="color: #0066cc; text-decoration: underline;">dknieriem@deatonengineering.com</a>
</div>`.trim();

/**
 * Places the standard signature immediately before the first horizontal rule.
 * Templates and AI sends use an &lt;hr&gt; before the small-print address / unsubscribe block.
 * If there is no &lt;hr&gt;, the signature is appended at the end (still above nothing — rare).
 */
export function embedOutboundSignatureHtml(html: string): string {
  const sig = OUTBOUND_SIGNATURE_HTML;
  const match = html.search(/<hr\b/i);
  if (match === -1) {
    return `${html.trimEnd()}\n${sig}\n`;
  }
  const before = html.slice(0, match).trimEnd();
  const fromHr = html.slice(match);
  return `${before}\n${sig}\n${fromHr}`;
}
