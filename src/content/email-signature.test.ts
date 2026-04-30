import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { embedOutboundSignatureHtml, OUTBOUND_SIGNATURE_HTML } from './email-signature.js';

describe('embedOutboundSignatureHtml', () => {
  it('inserts signature before the first hr', () => {
    const html = '<p>Hello</p>\n<hr>\n<p>footer</p>';
    const out = embedOutboundSignatureHtml(html);
    assert.ok(out.includes('David Knieriem'));
    assert.ok(out.includes('<hr>'));
    const sigPos = out.indexOf('David Knieriem');
    const hrPos = out.search(/<hr\b/i);
    assert.ok(sigPos !== -1 && hrPos !== -1);
    assert.ok(sigPos < hrPos, 'signature should appear before hr');
  });

  it('appends signature when there is no hr', () => {
    const html = '<p>Only body</p>';
    const out = embedOutboundSignatureHtml(html);
    assert.ok(out.includes(OUTBOUND_SIGNATURE_HTML.slice(0, 40)));
  });
});
