#!/usr/bin/env node
// github-hub poller: snapshot all own public repos, build dashboard data,
// detect new activity (issues / comments / PRs / stars), optionally notify Feishu.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('data', { recursive: true });

const USER = '6mt';
const TOKEN = process.env.GITHUB_TOKEN;
const FEISHU_WEBHOOK = process.env.FEISHU_WEBHOOK || '';
const STATE_FILE = 'data/state.json';
const DATA_FILE = 'data/data.json';
const FEED_LIMIT = 120;

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'github-hub-poller',
};

async function api(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

function loadJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function eventToFeed(repo, ev) {
  const base = { at: ev.created_at, repo, actor: ev.actor?.login || '', url: '', title: '', body: '' };
  switch (ev.type) {
    case 'IssuesEvent': {
      const i = ev.payload.issue;
      Object.assign(base, {
        kind: `issue-${ev.payload.action}`,
        title: `issue ${ev.payload.action}: ${i.title}`,
        body: (i.body || '').slice(0, 280),
        url: i.html_url,
      });
      return base;
    }
    case 'IssueCommentEvent': {
      const c = ev.payload.comment;
      Object.assign(base, {
        kind: 'issue-comment',
        title: `comment on: ${ev.payload.issue.title}`,
        body: (c.body || '').slice(0, 280),
        url: c.html_url,
      });
      return base;
    }
    case 'PullRequestEvent': {
      const p = ev.payload.pull_request;
      Object.assign(base, {
        kind: `pr-${ev.payload.action}`,
        title: `PR ${ev.payload.action}: ${p.title}`,
        body: (p.body || '').slice(0, 280),
        url: p.html_url,
      });
      return base;
    }
    case 'PullRequestReviewEvent': {
      const p = ev.payload.pull_request;
      Object.assign(base, {
        kind: 'pr-review',
        title: `review on PR: ${p.title}`,
        body: (ev.payload.review.body || '').slice(0, 280),
        url: ev.payload.review.html_url,
      });
      return base;
    }
    case 'PullRequestReviewCommentEvent': {
      Object.assign(base, {
        kind: 'pr-comment',
        title: `comment on PR: ${ev.payload.pull_request.title}`,
        body: (ev.payload.comment.body || '').slice(0, 280),
        url: ev.payload.comment.html_url,
      });
      return base;
    }
    case 'ForkEvent':
      Object.assign(base, {
        kind: 'fork',
        title: `forked by ${ev.actor.login}`,
        url: `https://github.com/${ev.payload.forkee.full_name}`,
      });
      return base;
    case 'WatchEvent':
      Object.assign(base, { kind: 'stars', title: `starred by ${ev.actor.login} ⭐`, url: `https://github.com/${repo}` });
      return base;
    default:
      return null;
  }
}

// ---------- discover repos ----------
const all = await api(`/users/${USER}/repos?per_page=100&sort=pushed`);
const repos = all.filter(r => !r.fork && !r.private && r.owner?.login === USER);

// ---------- load state ----------
const state = loadJson(STATE_FILE, { lastEventId: {}, stars: {} });

// ---------- snapshot + events ----------
const feed = loadJson(DATA_FILE, { feed: [] }).feed || [];
const newFeedItems = [];
const repoCards = [];

for (const r of repos) {
  const [events, pulls] = await Promise.all([
    api(`/repos/${r.full_name}/events?per_page=100`),
    api(`/repos/${r.full_name}/pulls?state=open&per_page=100`),
  ]);
  const prCount = pulls.length;
  const openIssues = Math.max(0, r.open_issues_count - prCount);

  // detect new activity by event id
  const lastId = state.lastEventId[r.full_name] || 0;
  let maxId = lastId;
  for (const ev of events) {
    const id = Number(ev.id);
    if (id > maxId) maxId = id;
    if (id <= lastId) continue;
    if (ev.actor?.login === USER) continue; // skip my own actions
    const item = eventToFeed(r.full_name, ev);
    if (item) { feed.unshift(item); newFeedItems.push(item); }
  }
  state.lastEventId[r.full_name] = maxId;

  // stars delta (for very active repos events may miss some stars)
  const prevStars = state.stars[r.full_name];
  if (prevStars !== undefined && r.stargazers_count > prevStars) {
    const item = {
      at: new Date().toISOString(),
      repo: r.full_name,
      kind: 'stars',
      title: `+${r.stargazers_count - prevStars} star(s) ⭐ (total ${r.stargazers_count})`,
      url: `https://github.com/${r.full_name}/stargazers`,
      actor: '',
    };
    feed.unshift(item); newFeedItems.push(item);
  }
  state.stars[r.full_name] = r.stargazers_count;

  repoCards.push({
    repo: r.full_name,
    url: r.html_url,
    desc: r.description || '',
    stars: r.stargazers_count,
    forks: r.forks_count,
    openIssues,
    openPRs: prCount,
    pushedAt: r.pushed_at,
    language: r.language || '',
  });
}

// sort & trim feed
feed.sort((a, b) => b.at.localeCompare(a.at));
feed.length = Math.min(feed.length, FEED_LIMIT);

state.lastRun = new Date().toISOString();

const data = {
  generatedAt: state.lastRun,
  repos: repoCards.sort((a, b) => (b.pushedAt || '').localeCompare(a.pushedAt || '')),
  totals: {
    stars: repoCards.reduce((s, r) => s + r.stars, 0),
    forks: repoCards.reduce((s, r) => s + r.forks, 0),
    openIssues: repoCards.reduce((s, r) => s + r.openIssues, 0),
    openPRs: repoCards.reduce((s, r) => s + r.openPRs, 0),
    repos: repoCards.length,
  },
  feed,
};

writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + '\n');
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');

// ---------- summary (visible in Actions run page) ----------
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary && newFeedItems.length) {
  const lines = newFeedItems.map(i => `- [${i.repo}] ${i.title} — ${i.actor} ([link](${i.url}))`);
  const txt = `## New activity since last run (${newFeedItems.length})\n${lines.join('\n')}\n`;
  const { appendFileSync } = await import('node:fs');
  appendFileSync(summary, txt);
}

// ---------- Feishu (optional; enabled by setting FEISHU_WEBHOOK secret) ----------
if (FEISHU_WEBHOOK && newFeedItems.length) {
  for (const i of newFeedItems.slice(0, 20)) {
    await fetch(FEISHU_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msg_type: 'interactive',
        card: {
          header: { title: { tag: 'plain_text', content: `🐙 ${i.repo} · ${i.kind}` } },
          elements: [
            { tag: 'div', text: { tag: 'lark_md', content: `**${i.title}**${i.actor ? `\nby ${i.actor}` : ''}${i.body ? `\n${i.body}` : ''}\n[打开 GitHub](${i.url})` } },
          ],
        },
      }),
    }).catch(() => {});
  }
}

console.log(`OK: ${repoCards.length} repos, ${newFeedItems.length} new activity items.`);
