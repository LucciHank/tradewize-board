// Shared board state (the whole tasks/months/members list) persisted as a JSON file
// committed to this same GitHub repo, plus live 2-way sync with Jira assignee.
// No database needed — the repo is the source of truth for the board,
// and Jira is the source of truth for assignee + status.
//
// When user edits owners on the board, this API syncs them to Jira (assign/unassign).
// When Jira assignee changes, board picks it up on next fetch.
const GITHUB_REPO = process.env.BOARD_GITHUB_REPO || 'LucciHank/tradewize-board';
const STATE_PATH = 'board-state.json';
const GITHUB_API = 'https://api.github.com';

// Jira account display names → team short names. Used only for display;
// actual assignment uses account IDs from Jira API.
const JIRA_NAME_MAP = {
  'Thai Tran Van': 'Thái',
  'Hoang Tran': 'Hoàng',
  'BimSpeed Hậu': 'Hậu',
  'nguyen tran': 'Nguyên',
  'Hiếu Lương': 'Hiếu',
  'Hoang Anh': 'Hoàng Anh',
  'Đinh Huyền Trang': 'Trang',
  'Phan Thi Hoai Phuong': 'Phương',
  // New team members (added 07/07) — verify Jira display names and update if different
  'Quang': 'Quang',
  'Lực': 'Lực',
  'Phú': 'Phú',
  'Đạt': 'Đạt',
  'Giang': 'Giang',
  'Chỉnh': 'Chỉnh',
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

const jiraAuth = () => Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
const jiraHeaders = (auth) => ({ Authorization: `Basic ${auth}`, Accept: 'application/json' });

async function jiraLookup(keys) {
  if (!keys.length || !process.env.JIRA_API_TOKEN) return { issues: {} };
  const jql = `key in (${keys.join(',')})`;
  const auth = jiraAuth();
  const url = `https://${process.env.JIRA_SITE}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=status,assignee&maxResults=100`;
  const res = await fetch(url, { headers: jiraHeaders(auth) });
  if (!res.ok) return { issues: {} };
  const json = await res.json();
  const issues = {};
  const nameToId = {}; // build reverse map: display name → account ID
  for (const issue of json.issues || []) {
    const assignee = issue.fields?.assignee;
    const displayName = assignee?.displayName || null;
    const accountId = assignee?.accountId || null;
    issues[issue.key] = {
      status: issue.fields?.status?.name || null,
      assignee: normalizeAssignee(displayName),
      displayName,
      accountId,
    };
    if (displayName && accountId) nameToId[displayName] = accountId;
  }
  return { issues, nameToId };
}

async function jiraAssign(issueKey, owners) {
  // owners is an array of team short names (Thái, Hoàng, etc).
  // We need to (re)assign the issue. First, fetch current assignee to build name→ID map.
  if (!process.env.JIRA_API_TOKEN) return;
  const auth = jiraAuth();
  const lookup = await jiraLookup([issueKey]);
  const issue = lookup.issues[issueKey];
  if (!issue) throw new Error(`Issue ${issueKey} not found in Jira`);

  // Find the first owner that has a Jira account.
  // ponytail: for simplicity, assume owners[0] is the person to assign. If multiple owners,
  // Jira only supports one assignee anyway, so pick the first and warn if there are more.
  if (owners.length > 1) console.warn(`jiraAssign: ${issueKey} has ${owners.length} owners, assigning only the first`);

  const ownerName = owners[0];
  if (!ownerName) {
    // Unassign
    const url = `https://${process.env.JIRA_SITE}/rest/api/3/issue/${issueKey}/assignee`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: jiraHeaders(auth),
      body: JSON.stringify({ accountId: null }),
    });
    if (!res.ok) throw new Error(`Jira unassign failed: ${res.status} ${await res.text()}`);
    return;
  }

  // Reverse map: team short name → Jira display name.
  // This is NOT the same as JIRA_NAME_MAP — we need to find which Jira user
  // has the team short name. We'll search by querying Jira API.
  // ponytail: for now, hardcode the reverse. If team structure changes, update this.
  const shortToJiraName = Object.fromEntries(Object.entries(JIRA_NAME_MAP).map(([j, s]) => [s, j]));
  const jiraDisplayName = shortToJiraName[ownerName];
  if (!jiraDisplayName) throw new Error(`Unknown team member: ${ownerName}`);

  // Look up the account ID by searching for the Jira display name.
  const searchUrl = `https://${process.env.JIRA_SITE}/rest/api/3/user/search?query=${encodeURIComponent(jiraDisplayName)}`;
  const searchRes = await fetch(searchUrl, { headers: jiraHeaders(auth) });
  if (!searchRes.ok) throw new Error(`Jira user search failed: ${searchRes.status}`);
  const users = await searchRes.json();
  const user = users.find(u => u.displayName === jiraDisplayName);
  if (!user) throw new Error(`No Jira user found for: ${jiraDisplayName}`);

  // Assign the issue.
  const assignUrl = `https://${process.env.JIRA_SITE}/rest/api/3/issue/${issueKey}/assignee`;
  const assignRes = await fetch(assignUrl, {
    method: 'PUT',
    headers: jiraHeaders(auth),
    body: JSON.stringify({ accountId: user.accountId }),
  });
  if (!assignRes.ok) throw new Error(`Jira assign failed: ${assignRes.status} ${await assignRes.text()}`);
}

async function syncOwnersToJira(oldState, newState) {
  if (!process.env.JIRA_API_TOKEN) return;
  if (!oldState || !newState) return;

  // For each task, detect if owners changed and sync to Jira.
  for (const newTask of newState.tasks) {
    const oldTask = oldState.tasks.find(t => t.code === newTask.code);
    const oldOwners = oldTask?.owners || [];
    const newOwners = newTask.owners || [];

    if (JSON.stringify(oldOwners) !== JSON.stringify(newOwners) && newTask.jira) {
      try {
        await jiraAssign(newTask.jira, newOwners);
      } catch (err) {
        console.error(`Failed to sync ${newTask.jira} owners to Jira:`, err.message);
        // Don't throw — keep the board state even if Jira sync fails.
      }
    }
  }
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

      // Load the old state to detect owner changes.
      const { state: oldState, sha } = await ghGetFile();

      // Sync owner changes to Jira.
      await syncOwnersToJira(oldState, state);

      // Save the new state.
      await ghPutFile(state, sha, `board: sync shared state (${new Date().toISOString()})`);
      return res.status(200).json({ ok: true });
    }

    const { state } = await ghGetFile();
    const keys = String(req.query.keys || '').split(',').map(k => k.trim()).filter(Boolean);
    const { issues: jira } = await jiraLookup([...new Set(keys)]);
    return res.status(200).json({ state, jira });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
