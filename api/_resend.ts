type SendEmailArgs = {
  subject: string;
  text: string;
};

export async function sendEmail(args: SendEmailArgs): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.DIGEST_EMAIL;
  const from = process.env.DIGEST_FROM || 'onboarding@resend.dev';

  if (!apiKey || !to) {
    console.warn(
      '[email] RESEND_API_KEY or DIGEST_EMAIL not set; skipping send',
    );
    return;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: args.subject,
      text: args.text,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[email] resend send failed:', response.status, errorText);
    throw new Error(`Resend send failed: ${response.status}`);
  }
}

export type LeakAlertArgs = {
  ts: number;
  leakedCanary: string;
  currentCanary: string;
  ipHash: string;
  userAgent: string;
  geoCountry: string | null;
};

export async function sendLeakAlert(args: LeakAlertArgs): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.LEAK_ALERT_FROM;
  const to = process.env.LEAK_ALERT_TO;

  if (!apiKey || !from || !to) {
    console.warn(
      '[email] RESEND_API_KEY / LEAK_ALERT_FROM / LEAK_ALERT_TO not set; skipping leak alert',
    );
    return;
  }

  const tsIso = new Date(args.ts).toISOString();
  const text =
    `A canary leak was detected on tusharjayanti.io.\n\n` +
    `Detected at: ${tsIso}\n` +
    `Leaked canary: ${args.leakedCanary}\n` +
    `Current canary: ${args.currentCanary}\n\n` +
    `Request metadata:\n` +
    `- IP hash: ${args.ipHash.slice(0, 16)}\n` +
    `- User agent: ${args.userAgent}\n` +
    `- Country: ${args.geoCountry ?? 'unknown'}\n\n` +
    `Action: redeploy tusharjayanti.io to rotate the canary and stop these alerts.\n` +
    `Manual redeploy: https://github.com/tusharjayanti/tusharjayanti.io/actions\n` +
    `or \`git commit --allow-empty -m "rotate canary" && git push\`.\n\n` +
    `This alert will repeat hourly until rotation.\n`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: '[tusharjayanti.io] Canary leak detected — still active',
      text,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(
      '[email] resend leak alert failed:',
      response.status,
      errorText,
    );
    throw new Error(`Resend leak alert failed: ${response.status}`);
  }
}
