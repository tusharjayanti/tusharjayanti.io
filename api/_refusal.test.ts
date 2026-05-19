import { describe, it, expect } from 'vitest';
import { detectRefusal } from './_refusal.js';

describe('detectRefusal', () => {
  it('flags responses containing a refusal phrase', () => {
    expect(
      detectRefusal('Not how this works. Want to know what I built at DISCO?'),
    ).toBe(true);
  });

  it('does not flag a long response that happens to contain a refusal phrase mid-text', () => {
    const longResponse =
      'At DISCO I owned the authentication and authorization platform. ' +
      'Not how this works was a comment someone made about the legacy ' +
      'permission graph traversal — it walked node by node and was the ' +
      'root cause of the slow workflow I fixed. The bulk delete I shipped ' +
      'dropped p99 from 4.2s to about 1s. We also migrated authentication ' +
      'off .NET + RavenDB to Kotlin + Spring Boot + PostgreSQL on AWS ' +
      'because RavenDB hit end of life with active CVEs.';
    expect(detectRefusal(longResponse)).toBe(false);
  });

  it('flags responses containing the shrug', () => {
    expect(detectRefusal('¯\\_(ツ)_/¯ no strong opinion.')).toBe(true);
  });

  it('does not flag a substantive answer with no refusal phrases', () => {
    const answer =
      'At DISCO I led the authentication service migration from .NET + ' +
      'RavenDB to Kotlin + Spring Boot + PostgreSQL on AWS, sequenced ' +
      'as a database cutover first then the rewrite.';
    expect(detectRefusal(answer)).toBe(false);
  });

  it('returns false for the empty string', () => {
    expect(detectRefusal('')).toBe(false);
  });
});
