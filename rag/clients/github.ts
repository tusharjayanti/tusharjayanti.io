// Octokit client wrapper. Lazy singleton matches api/_voyage.ts and
// api/_supabase.ts. Reads GITHUB_TOKEN from env — optional for public
// repos (unauthenticated rate limit is 60/hr/IP, plenty for a 6-repo
// backfill; setting the token lifts to 5000/hr, recommended before
// the demo URL is shared). Used by the M2.5 README backfill script
// and the sub-spec 3 webhook handler.

import { Octokit } from '@octokit/rest';

let _client: Octokit | null = null;
let _warnedNoToken = false;

export function getGithubClient(): Octokit {
  if (_client) return _client;
  const token = process.env.GITHUB_TOKEN;
  if (!token && !_warnedNoToken) {
    console.warn(
      '[github] GITHUB_TOKEN not set; falling back to unauthenticated requests (60/hr/IP limit)',
    );
    _warnedNoToken = true;
  }
  _client = new Octokit(token ? { auth: token } : {});
  return _client;
}

// Fetch the README of a public repo. Returns the markdown content as
// a UTF-8 string. Throws on 404 with a clear "README not found"
// message so the backfill can surface which repo failed; other errors
// (network, rate limit, auth) propagate untouched.
export async function fetchReadme(
  owner: string,
  repo: string,
): Promise<string> {
  const client = getGithubClient();
  try {
    const { data } = await client.repos.getReadme({ owner, repo });
    return Buffer.from(data.content, 'base64').toString('utf-8');
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404) {
      throw new Error(`README not found for ${owner}/${repo}`);
    }
    throw error;
  }
}
