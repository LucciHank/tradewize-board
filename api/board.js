// Shared board state (the whole tasks/months/members list) persisted as a JSON file
// committed to this same GitHub repo, plus a live Jira lookup for status/assignee.
// No database needed — the repo already exists and is already the source of truth
// for the static page.
//
// ponytail: last-write-wins on the full state blob (no per-field merge/CRDT). Fine
// for a small team saving occasionally; would need real conflict resolution if two
// people are editing the same task within the same second.
const GITHUB_REPO = process.env.BOARD_GITHUB_REPO || 'LucciHank/tradewize-board';
const STATE_PATH = 'board-state.json';
const GITHUB_API = 'https://api.github.com';

// Jira account display names don't match the team's short names used on the board.
// Mapped from every distinct assignee seen across the whole TD project (2026-07-07).
const JIRA_NAME_MAP = {
  'Thai Tran Van': 'Thái',
  'Hoang Tran': 'Hoàng',
  'BimSpeed Hậu': 'Hậu',
  'nguyen tran': 'Nguyên',
  'Hiếu Lương': 'Hiếu',
  'Hoang Anh': 'Hoàng Anh',
  'Đinh Huyền Trang': 'Trang',
  'Phan Thi Hoai Phuong': 'Phương',
};
const normalizeAssignee = name => (name == null ? null : (JIRA_NAME_MAP[name] || name));

async function ghGetFile() {
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/contents/${STATE_PATH}`, {
    headers: {
      Authorization: `token ${process.env.GITHUB_TOKEN}`,
      'User-Agent': 'tradewize-board',
      Accept: 'application/vnd.github+json',
    },
  });
  if (res.status === 404) return { sha: null, state: null };
  if (!res.ok) throw new Error(`GitHub read failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const content = Buffer.from(json.content, 'base64').toString('utf8');
  const data = content.trim() ? JSON.parse(content) : null;
  // Older deploys stored {overrides:{...}} only — that shape has no tasks, treat as empty.
  const state = data && Array.isArray(data.tasks) ? data : null;
  return { sha: json.sha, state };
}

async function ghPutFile(state, sha, message) {
  const body = {
    message,
    content: Buffer.from(JSON.stringify(state, null, 2)).toString('base64'),
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
      assignee: normalizeAssignee(issue.fields?.assignee?.displayName || null),
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
      const { state } = req.body || {};
      if (!state || !Array.isArray(state.tasks) || !Array.isArray(state.months) || !Array.isArray(state.members)) {
        return res.status(400).json({ error: 'body must be { state: { tasks, months, members } }' });
      }
      const { sha } = await ghGetFile();
      await ghPutFile(state, sha, `board: sync shared state (${new Date().toISOString()})`);
      return res.status(200).json({ ok: true });
    }

    const { state } = await ghGetFile();
    const keys = String(req.query.keys || '').split(',').map(k => k.trim()).filter(Boolean);
    const jira = await jiraLookup([...new Set(keys)]);
    return res.status(200).json({ state, jira });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
