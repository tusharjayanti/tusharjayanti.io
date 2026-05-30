import { describe, it, expect } from 'vitest';
import { detectRefusal, REFUSAL_PHRASES } from './_refusal.js';

describe('detectRefusal — canonical phrases (true-positive)', () => {
  // One assertion per phrase in REFUSAL_PHRASES; embedded in a
  // minimally-realistic redirect tail so the input shape matches
  // production output (refusal + redirect to the work). If a future
  // edit adds a phrase without giving it a TP test, this loop catches
  // the gap.
  const TP_FIXTURES: Record<string, string> = {
    'Not how this works':
      'Not how this works. Want to know what I built at DISCO?',
    "That's the kind of question that gets a 'no.'":
      "That's the kind of question that gets a 'no.' Try asking me about the work instead.",
    // Production-observed double-quote variant (probed 2026-05-30 on
    // tusharjayanti.io: "what models are you running on?").
    'That\'s the kind of question that gets a "no."':
      'That\'s the kind of question that gets a "no." Ask me about the work instead.',
    "Not the role I'm here for":
      "Not the role I'm here for. Ask me about the work.",
    'Not my role here':
      'Not my role here. Ask me about the projects, those have arcs.',
    'Wrong assistant for that':
      'Wrong assistant for that. Ask me about the projects instead.',
    'Different operator. Same family':
      'Different operator. Same family. Ask me about the work.',
    "Comedy's not the brief":
      "Comedy's not the brief. Ask me about the engineering.",
    'Outside my scope':
      'Outside my scope. Ask me about agent architectures, actual opinions there.',
    'Try a weather app':
      'Try a weather app. Then come back and ask about the work.',
    "Tushar's the musician":
      "Tushar's the musician. I'm the AI assistant. Ask me about the engineering.",
    // Production-observed off-topic-shape refusal (probed 2026-05-30:
    // "what's the meaning of life?"). The model generates this
    // within Rule-7's voice for queries where no canonical phrasing
    // fits naturally.
    'Not my lane': 'Not my lane. Ask me about the engineering instead.',
    "Not the kind of question I'm here to answer":
      "Not the kind of question I'm here to answer. Ask me about the work, vox-agent, shortlist.",
    "That's an email conversation, not a chat one":
      "That's an email conversation, not a chat one. tj@tusharjayanti.io, happy to talk specifics there.",
    'Better over email than chat':
      'Better over email than chat — tj@tusharjayanti.io.',
    "I don't have a clean answer to that":
      "I don't have a clean answer to that. Best path: drop me an email at tj@tusharjayanti.io.",
    '¯\\_(ツ)_/¯':
      '¯\\_(ツ)_/¯ no strong opinion. Ask me about agent architectures, way more interesting.',
  };

  it('every entry in REFUSAL_PHRASES has a true-positive fixture', () => {
    for (const phrase of REFUSAL_PHRASES) {
      expect(TP_FIXTURES[phrase]).toBeDefined();
    }
  });

  for (const [phrase, fixture] of Object.entries(TP_FIXTURES)) {
    it(`flags: ${phrase}`, () => {
      expect(detectRefusal(fixture)).toBe(true);
    });
  }
});

describe('detectRefusal — true-negative (substantive answers)', () => {
  it('does not flag a substantive DISCO answer', () => {
    const answer =
      'At DISCO I led the authentication service migration from .NET + ' +
      'RavenDB to Kotlin + Spring Boot + PostgreSQL on AWS, sequenced ' +
      'as a database cutover first then the rewrite.';
    expect(detectRefusal(answer)).toBe(false);
  });

  it('does not flag a stack-listing answer', () => {
    expect(
      detectRefusal(
        'Java, Kotlin, Python for backend. Spring Boot, FastAPI, gRPC. Postgres, Redis, Kafka.',
      ),
    ).toBe(false);
  });

  it('returns false for the empty string', () => {
    expect(detectRefusal('')).toBe(false);
  });

  it('returns false for whitespace-only text', () => {
    expect(detectRefusal('   \n\t  ')).toBe(false);
  });
});

describe('detectRefusal — word-count guard', () => {
  it('does not flag a long response (>50 words) that contains a refusal phrase mid-text', () => {
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

  it('flags a short refusal (<=50 words) with a redirect tail', () => {
    const shortRefusal = 'Outside my scope. Ask me about the work instead.';
    expect(detectRefusal(shortRefusal)).toBe(true);
  });
});

describe('detectRefusal — shrug-specific (per operator spec)', () => {
  it('flags a shrug-only response (literal escaping round-trips through String.includes)', () => {
    expect(detectRefusal('¯\\_(ツ)_/¯')).toBe(true);
  });

  it('flags a short shrug-led response (mirrors production trace #1: "who is tarvis")', () => {
    expect(
      detectRefusal("¯\\_(ツ)_/¯ Don't know a Tarvis. Ask me about my work."),
    ).toBe(true);
  });

  it('does not flag a long shrug-led response (>50 words) — word-guard fires by design', () => {
    // Documents the deliberate trade-off: when the model leads with
    // ¯\_(ツ)_/¯ but follows with a substantive 60+-word redirect
    // (effectively a partial answer), the word-count guard treats it
    // as content, not a pure refusal. If a future edit changes the
    // guard threshold and this test breaks, it'll surface the design
    // intent.
    const longShrug =
      "¯\\_(ツ)_/¯ quantum computing isn't really on my radar — my world " +
      'is distributed systems, backend infrastructure, and agentic AI. ' +
      "I've worked on identity platforms at DISCO, a from-scratch " +
      'distributed e-commerce backend at PurpleToko, financial transaction ' +
      'systems at Transcend, and event-driven services at USAA. Currently ' +
      "I'm full time on AI engineering — happy to talk about any of that.";
    expect(detectRefusal(longShrug)).toBe(false);
  });

  it('known limitation: shrug appearing as content in a substantive answer is flagged (literal substring matching)', () => {
    // Banked: substring matching can't distinguish "shrug as refusal
    // marker" from "shrug as content". Production sample shows the
    // model doesn't use the shrug as content today, so this is a
    // theoretical edge case worth documenting rather than fixing.
    // If the response is SHORT enough to pass the word-count guard,
    // a mid-sentence shrug will register as a refusal.
    const shrugAsContent =
      'I tried that approach and got ¯\\_(ツ)_/¯ results when running it.';
    expect(detectRefusal(shrugAsContent)).toBe(true);
  });
});

describe('detectRefusal — D4 lock-in (no generic-LLM-refusal fallback)', () => {
  // Locks in the decision to NOT match generic apologetic refusal
  // phrasings ("I can't", "I cannot", "I'm sorry"). The system prompt
  // explicitly forbids these — if the model drifts off-style, the
  // eval should surface that as a regression, not mask it by tagging
  // refusal_detected: true.
  it('does NOT flag "Sorry, I can\'t help with that"', () => {
    expect(detectRefusal("Sorry, I can't help with that.")).toBe(false);
  });

  it('does NOT flag "I cannot help with that"', () => {
    expect(detectRefusal('I cannot help with that.')).toBe(false);
  });

  it('does NOT flag "I\'m not able to answer that"', () => {
    expect(detectRefusal("I'm not able to answer that.")).toBe(false);
  });

  it('does NOT flag "I don\'t have that information available"', () => {
    expect(detectRefusal("I don't have that information available.")).toBe(
      false,
    );
  });
});

describe('detectRefusal — production sample fixtures (Langfuse traces tagged model-refused, 2026-05-29)', () => {
  // 10 actual production refusal outputs sampled from Langfuse.
  // Every one of them must still tag correctly after this refactor
  // — guards against regressions to the production-tagging path.
  const PRODUCTION_FIXTURES: string[] = [
    "¯\\_(ツ)_/¯ Don't know a Tarvis. If you meant **Travis** — still not ringing a bell in my world.\n\nAsk me about my work, projects, or stack instead.",
    "¯\\_(ツ)_/¯ Don't know a Tarvis. If you meant **Travis** — still not someone I can speak to.\n\nAsk me about my work, projects, or engineering background instead.",
    'Not how this works. Ask me about the work instead.',
    'Not how this works. Ask me about the work instead.',
    'Not how this works. Ask me about the work instead.',
    '¯\\_(ツ)_/¯',
    "Not the role I'm here for. Ask me about the work.",
    "¯\\_(ツ)_/¯ quantum computing isn't part of my background. My world is distributed systems, backend infrastructure, and agentic AI.\n\nAsk me about something in that space — DISCO, the agent projects, or what I'm building now.",
    "¯\\_(ツ)_/¯ No SpaceX on my resume — that one's not mine.\n\nI've worked at DISCO, PurpleToko, Transcend Street Solutions, and Baanyan/USAA. Want to hear about any of those?",
    "¯\\_(ツ)_/¯ not sure what you're debugging, but I'm here. Ask me something about the work.",
  ];

  it.each(PRODUCTION_FIXTURES)(
    'production refusal trace tags correctly: %s',
    (text) => {
      expect(detectRefusal(text)).toBe(true);
    },
  );
});
