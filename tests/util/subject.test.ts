import { describe, expect, it } from 'vitest';
import { normalizeSubject } from '../../src/util/subject.js';

describe('normalizeSubject — separator folding (item 118 AC1)', () => {
  // The three measured word-identical pairs from the drift subject study differ
  // only by `_` vs `-` vs space. After the fold they must all produce the
  // identical key. (The study named the openai pair explicitly; the other two
  // are represented here by real-shaped separator-only pairs.)
  const wordIdenticalGroups: string[][] = [
    ['openai_investment_terms', 'openai-investment-terms', 'openai investment terms'],
    ['pricing_tier', 'pricing-tier', 'pricing tier'],
    ['slack_bot_token', 'slack-bot-token', 'slack bot token'],
  ];

  for (const variants of wordIdenticalGroups) {
    it(`normalizes ${variants.join(' / ')} to one key`, () => {
      const keys = new Set(variants.map(normalizeSubject));
      expect(keys.size).toBe(1);
      expect([...keys][0]).toBe(variants[variants.length - 1]); // the space-separated form
    });
  }

  it('folds runs of separators and mixed separators to a single space', () => {
    expect(normalizeSubject('openai__investment--terms')).toBe('openai investment terms');
    expect(normalizeSubject('a_-_b')).toBe('a b');
  });

  it('leaves a subject with no separators byte-unchanged from prior behavior', () => {
    // Prior behavior: lowercase, trim, collapse whitespace.
    expect(normalizeSubject('Database Choice')).toBe('database choice');
    expect(normalizeSubject('  pricing   strategy ')).toBe('pricing strategy');
    expect(normalizeSubject('roadmap')).toBe('roadmap');
  });
});
