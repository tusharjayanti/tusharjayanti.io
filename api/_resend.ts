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
