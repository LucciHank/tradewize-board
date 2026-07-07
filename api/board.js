// Shared board state (priority overrides) persisted as a JSON file committed to this
// same GitHub repo, plus a live Jira lookup for status/assignee. No database needed —
// the repo already exists and is already the source of truth for the static page.
const GITHUB_REPO = process.env.BOARD_GITHUB_REPO || 'LucciHank/tradewize-board';
const STATE_PATH = 'board-state.json';
const GITHUB_API = 'https://api.github.com';
const VALID_PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3', 'STG']);

async function ghGetState() {
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/contents/${STATE_PATH}`, {
    headers: {
      Authorization: `token ${process.env.GITHUB_TOKEN}`,
      'User-Agent': 'tradewize-board',
      Accept: 'application/vnd.github+json',
    },
  });
  if (res.status === 404) return { sha: null, overrides: {} };
  if (!res.ok) throw new Error(`GitHub read failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const content = Buffer.from(json.content, 'base64').toString('utf8');
  const data = content.trim() ? JSON.parse(content) : {};
  return { sha: json.sha, overrides: data.overrides || {} };
}

async function ghPutState(overrides, sha, message) {
  const body = {
    message,
    content: Buffer.from(JSON.stringify({ overrides }, null, 2)).toString('base64'),
    ...(sha ? { sha } : {}),
  };
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/contents/${STATE_PATH}`, {
    method: 'PUT',
    headers: {
      Authorization: `token ${process.env.GITHUB_TOKEN}`,
      'User-Agent': 'tradewize-board',
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub write failed: ${res.status} ${await res.text()}`);
}

async function jiraLookup(keys) {
  if (!keys.length || !process.env.JIRA_API_TOKEN) return {};
  const jql = `key in (${keys.join(',')})`;
  const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
  const url = `https://${process.env.JIRA_SITE}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=status,assignee&maxResults=100`;
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } });
  if (!res.ok) return {};
  const json = await res.json();
  const map = {};
  for (const issue of json.issues || []) {
    map[issue.key] = {
      status: issue.fields?.status?.name || null,
      assignee: issue.fields?.assignee?.displayName || null,
    };
  }
  return map;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'POST') {
      const { code, priority } = req.body || {};
      if (!code || !VALID_PRIORITIES.has(priority)) {
        return res.status(400).json({ error: 'code and a valid priority (P0/P1/P2/P3/STG) are required' });
      }
      const { sha, overrides } = await ghGetState();
      overrides[code] = { priority, updated_at: new Date().toISOString() };
      await ghPutState(overrides, sha, `board: set ${code} priority to ${priority}`);
      return res.status(200).json({ ok: true, overrides });
    }

    const { overrides } = await ghGetState();
    const keys = String(req.query.keys || '').split(',').map(k => k.trim()).filter(Boolean);
    const jira = await jiraLookup([...new Set(keys)]);
    return res.status(200).json({ overrides, jira });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
