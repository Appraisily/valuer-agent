import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { validateComparableLot } from '@appraisily/auction-contracts';
import {
  toCanonicalComparableLot,
  type ScraperDbLot,
} from '../services/scraper-db.js';

const require = createRequire(import.meta.url);
const fixture = require('@appraisily/auction-contracts/fixtures/comparable-lot-v1.json');

describe('auction comparable contract compatibility', () => {
  it('accepts the shared canonical comparable fixture', () => {
    expect(validateComparableLot(fixture)).toBe(fixture);
  });

  it('maps the deployed Valuer scraper-DB shape without field drift', () => {
    const lot: ScraperDbLot = {
      lotUid: fixture.lotUid,
      lotRef: null,
      title: fixture.title,
      description: fixture.description,
      houseName: fixture.houseName,
      auctionDate: fixture.auctionDate,
      priceRealised: fixture.priceRealised,
      currency: fixture.currency,
      currencySymbol: '$',
      estimateMin: fixture.estimateMin,
      estimateMax: fixture.estimateMax,
      lotNumber: null,
      saleType: null,
      sourceUrl: fixture.sourceUrl,
      rankingScore: fixture.rankingScore,
      imagePath: null,
      imageFileName: null,
      imageUrl: fixture.imageUrl,
      assetStatus: fixture.assetStatus,
      assetVerifiedAt: fixture.assetVerifiedAt,
    };
    expect(toCanonicalComparableLot(lot)).toEqual({
      schemaVersion: 1,
      lotUid: fixture.lotUid,
      lotRef: null,
      title: fixture.title,
      description: fixture.description,
      houseName: fixture.houseName,
      saleType: null,
      auctionDate: fixture.auctionDate,
      priceRealised: fixture.priceRealised,
      currency: fixture.currency,
      estimateMin: fixture.estimateMin,
      estimateMax: fixture.estimateMax,
      lotNumber: null,
      sourceUrl: fixture.sourceUrl,
      rankingScore: fixture.rankingScore,
      assetStatus: fixture.assetStatus,
      assetVerifiedAt: fixture.assetVerifiedAt,
      imageUrl: fixture.imageUrl,
    });
  });
});
