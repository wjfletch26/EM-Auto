import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mayOfferInPersonTexasVisit,
  visitLanguageGuidanceForPrompt,
  describeNonTriangleVisitViolationIfAny,
} from './texas-triangle-visit-policy.js';

describe('mayOfferInPersonTexasVisit', () => {
  it('is false when headquarters are empty or remote', () => {
    assert.equal(mayOfferInPersonTexasVisit(''), false);
    assert.equal(mayOfferInPersonTexasVisit(null), false);
    assert.equal(mayOfferInPersonTexasVisit('Remote, worldwide team'), false);
  });

  it('is true for major Texas Triangle metros', () => {
    assert.equal(mayOfferInPersonTexasVisit('Austin, TX'), true);
    assert.equal(mayOfferInPersonTexasVisit('Houston, Texas'), true);
    assert.equal(mayOfferInPersonTexasVisit('Dallas, TX'), true);
    assert.equal(mayOfferInPersonTexasVisit('Georgetown, TX'), true);
  });

  it('is true for corridor cities without repeating Texas token', () => {
    assert.equal(mayOfferInPersonTexasVisit('Waco'), true);
    assert.equal(mayOfferInPersonTexasVisit('College Station, TX'), true);
  });

  it('is false for Texas cities far from the megaregion', () => {
    assert.equal(mayOfferInPersonTexasVisit('El Paso, TX'), false);
    assert.equal(mayOfferInPersonTexasVisit('Lubbock, Texas'), false);
    assert.equal(mayOfferInPersonTexasVisit('Tyler, TX'), false);
  });

  it('is false for obvious non-Texas US locations', () => {
    assert.equal(mayOfferInPersonTexasVisit('San Francisco, CA'), false);
    assert.equal(mayOfferInPersonTexasVisit('Boston, Massachusetts'), false);
    assert.equal(mayOfferInPersonTexasVisit('Chicago, IL'), false);
  });

  it('disambiguates Austin MN and Georgetown KY', () => {
    assert.equal(mayOfferInPersonTexasVisit('Austin, MN'), false);
    assert.equal(mayOfferInPersonTexasVisit('Georgetown, Kentucky'), false);
  });
});

describe('describeNonTriangleVisitViolationIfAny', () => {
  it('detects sending engineers and on-site commissioning', () => {
    assert.ok(
      describeNonTriangleVisitViolationIfAny(
        'whether sending engineers for on-site commissioning or shipping',
      ),
    );
  });

  it('returns null for remote-only logistics wording', () => {
    assert.equal(
      describeNonTriangleVisitViolationIfAny(
        'We coordinate shipments and remote design reviews from Central Texas.',
      ),
      null,
    );
  });
});

describe('visitLanguageGuidanceForPrompt', () => {
  it('forbids visit language when outside triangle', () => {
    const g = visitLanguageGuidanceForPrompt('Chicago, IL');
    assert.ok(g.includes('**not** treated'));
    assert.ok(g.includes('drop by'));
  });

  it('allows visits when inside triangle', () => {
    const g = visitLanguageGuidanceForPrompt('San Antonio, TX');
    assert.ok(g.includes('near the Texas Triangle'));
  });
});
