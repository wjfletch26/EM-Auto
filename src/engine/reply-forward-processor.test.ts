import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Contact } from '../services/sheets-types.js';
import { processForwardedReplyEvents } from './reply-forward-processor.js';

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    email: 'person@example.com',
    firstName: 'Pat',
    lastName: 'Person',
    company: 'Acme',
    title: 'Manager',
    campaignId: 'q1',
    status: 'active',
    lastStepSent: 1,
    lastSendDate: new Date().toISOString(),
    replyStatus: null,
    replyDate: null,
    replySnippet: '',
    unsubscribed: false,
    unsubscribeDate: null,
    unsubscribeSource: null,
    bounced: false,
    bounceType: null,
    bounceDate: null,
    softBounceCount: 0,
    custom1: '',
    custom2: '',
    notes: '',
    _rowIndex: 2,
    ...overrides,
  };
}

describe('reply-forward-processor', () => {
  it('forwards reply and pauses matching contact', async () => {
    const contact = makeContact();
    let updateCount = 0;
    let appendCount = 0;
    let forwardCount = 0;

    const result = await processForwardedReplyEvents(
      [{
        contactEmail: contact.email,
        fromEmail: 'lead@example.com',
        subject: 'Re: outreach',
        body: 'Please call me next week.',
        receivedAt: new Date().toISOString(),
      }],
      {
        getContacts: async () => [contact],
        updateContact: async (_email, _row, updates) => {
          updateCount++;
          assert.equal(updates.status, 'paused');
          assert.equal(updates.replyStatus, 'forwarded');
        },
        appendReplyLog: async () => {
          appendCount++;
        },
        forwardReplyForReview: async () => {
          forwardCount++;
          return { messageId: 'm1', accepted: ['x'], rejected: [] };
        },
      },
    );

    assert.equal(forwardCount, 1);
    assert.equal(updateCount, 1);
    assert.equal(appendCount, 1);
    assert.deepEqual(result.summary, { processed: 1, paused: 1, failed: 0 });
    assert.equal(result.retryQueue.length, 0);
  });

  it('keeps failed events in retry queue', async () => {
    const event = {
      contactEmail: 'person@example.com',
      fromEmail: 'lead@example.com',
      subject: 'Re: outreach',
      body: 'Please call me next week.',
      receivedAt: new Date().toISOString(),
    };

    const result = await processForwardedReplyEvents(
      [event],
      {
        getContacts: async () => [makeContact()],
        updateContact: async () => undefined,
        appendReplyLog: async () => undefined,
        forwardReplyForReview: async () => {
          throw new Error('smtp failed');
        },
      },
    );

    assert.deepEqual(result.summary, { processed: 0, paused: 0, failed: 1 });
    assert.equal(result.retryQueue.length, 1);
    assert.equal(result.retryQueue[0].contactEmail, event.contactEmail);
  });
});
