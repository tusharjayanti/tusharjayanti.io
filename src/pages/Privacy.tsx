export function Privacy() {
  return (
    <article>
      <h1>privacy</h1>
      <p>
        This site logs the messages you send to the chat assistant (the{' '}
        <code>ask</code> command and the floating widget on the CV page) so I
        can review them and improve the assistant.
      </p>
      <h2>What's stored</h2>
      <ul>
        <li>The text of your question and a short preview of the response.</li>
        <li>
          A SHA-256 hash of your IP address (used for rate-limiting; the raw IP
          is not stored).
        </li>
        <li>A timestamp.</li>
      </ul>
      <h2>Retention</h2>
      <p>
        Chat logs auto-expire after 7 days. A daily summary email is sent to me
        and the underlying log entries are deleted afterwards.
      </p>
      <h2>Third parties</h2>
      <ul>
        <li>
          Anthropic (Claude API): the messages are sent here to generate
          responses.
        </li>
        <li>Vercel: hosting and Edge functions.</li>
        <li>Upstash Redis: short-term storage for rate limit and log.</li>
        <li>Resend: sends the daily summary email.</li>
      </ul>
      <h2>Contact</h2>
      <p>
        Email <a href="mailto:tj@tusharjayanti.io">tj@tusharjayanti.io</a> for
        any concerns.
      </p>
    </article>
  );
}
