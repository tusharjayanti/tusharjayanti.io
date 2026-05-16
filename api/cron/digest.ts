import { Redis } from '@upstash/redis';
import Anthropic from '@anthropic-ai/sdk';
import { sendEmail } from '../_resend.js';
import { getHeader, writeResponse } from '../_compat.js';

export const runtime = 'edge';

const redis = Redis.fromEnv();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function yesterdayUtc(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

type ChatLogEntry = {
  ts: string;
  q: string;
  a_preview: string;
};

type ErrorLogEntry = {
  ts: string;
  category: string;
  q: string;
  detail: string;
};

function parseEntries<T>(entries: unknown[] | null): T[] {
  if (!entries) return [];
  const out: T[] = [];
  for (const s of entries) {
    if (typeof s === 'string') {
      try {
        out.push(JSON.parse(s) as T);
      } catch {
        // skip malformed entry
      }
    } else if (s && typeof s === 'object') {
      // Upstash may auto-parse JSON content in some cases
      out.push(s as T);
    }
  }
  return out;
}

function buildDigestPrompt(
  date: string,
  chats: ChatLogEntry[],
  errors: ErrorLogEntry[],
): string {
  const chatSample = chats
    .slice(0, 30)
    .map(
      (c, i) =>
        `  ${i + 1}. Q: "${c.q}" → A: "${(c.a_preview ?? '').slice(0, 100)}..."`,
    )
    .join('\n');

  const errorSample = errors
    .slice(0, 20)
    .map(
      (e, i) =>
        `  ${i + 1}. [${e.category}] Q: "${(e.q ?? '').slice(0, 80)}" — ${(e.detail ?? '').slice(0, 100)}`,
    )
    .join('\n');

  return `You're writing a daily digest email for Tushar about his portfolio site (tusharjayanti.io) activity on ${date}.

Write a short, scannable summary (200-400 words max) in plain text covering:
1. How many people chatted and rough sense of what they asked about (themes, not verbatim)
2. Any notable or interesting questions worth highlighting
3. Error summary if any errors occurred
4. One actionable insight if there's a pattern worth noting

Tone: friendly, direct, like a colleague sending an end-of-day update. No corporate fluff. Use Tushar's voice — dry, engineer-flavored.

DATA:
- Total chats: ${chats.length}
- Total errors: ${errors.length}

Chat samples (up to 30):
${chatSample}

Error samples (up to 20):
${errorSample}

Write the digest:`;
}

export default async function handler(
  req: Request,
  resOrCtx?: unknown,
): Promise<Response | void> {
  // Vercel cron sends an Authorization header with CRON_SECRET if configured.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = getHeader(req, 'authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return writeResponse(
        resOrCtx,
        new Response('Unauthorized', { status: 401 }),
      );
    }
  }

  const date = yesterdayUtc();

  try {
    const chatKey = `chat:log:${date}`;
    const errorKey = `chat:errors:${date}`;

    const [chatEntries, errorEntries] = await Promise.all([
      redis.lrange(chatKey, 0, -1),
      redis.lrange(errorKey, 0, -1),
    ]);

    const chats = parseEntries<ChatLogEntry>(chatEntries);
    const errors = parseEntries<ErrorLogEntry>(errorEntries);

    const chatCount = chats.length;
    const errorCount = errors.length;

    if (chatCount === 0 && errorCount === 0) {
      await sendEmail({
        subject: `tusharjayanti.io digest — ${date} (quiet)`,
        text: `No chat activity or errors yesterday (${date}). All quiet on the portfolio.`,
      });
      return writeResponse(
        resOrCtx,
        new Response(JSON.stringify({ ok: true, chats: 0, errors: 0 }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    }

    const summaryPrompt = buildDigestPrompt(date, chats, errors);

    const summary = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      messages: [{ role: 'user', content: summaryPrompt }],
    });

    const summaryText = summary.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { type: 'text'; text: string }).text)
      .join('\n');

    await sendEmail({
      subject: `tusharjayanti.io digest — ${date} · ${chatCount} chats · ${errorCount} errors`,
      text: summaryText,
    });

    return writeResponse(
      resOrCtx,
      new Response(
        JSON.stringify({ ok: true, chats: chatCount, errors: errorCount }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
  } catch (err) {
    console.error('[digest] error:', err);
    return writeResponse(
      resOrCtx,
      new Response(
        JSON.stringify({
          error: err instanceof Error ? err.message : 'unknown error',
        }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      ),
    );
  }
}
