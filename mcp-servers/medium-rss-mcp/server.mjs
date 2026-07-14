#!/usr/bin/env node
// Minimal, zero-dependency Medium RSS MCP server (stdio JSON-RPC 2.0).
// Tools: medium_tag, medium_user, medium_fetch — fetch Medium RSS feeds for technique research.
import { createInterface } from 'node:readline';

const SERVER = { name: 'medium-rss-mcp', version: '1.0.0' };
const PROTO = '2024-11-05';
const TOOLS = [
  { name: 'medium_tag', description: 'Fetch latest Medium posts for a tag (e.g. "bug-bounty", "xss"). Returns title, link, date, categories, snippet.',
    inputSchema: { type: 'object', properties: { tag: { type: 'string' }, limit: { type: 'number' }, full: { type: 'boolean' } }, required: ['tag'] } },
  { name: 'medium_user', description: 'Fetch latest Medium posts by a user handle (with or without leading @).',
    inputSchema: { type: 'object', properties: { username: { type: 'string' }, limit: { type: 'number' }, full: { type: 'boolean' } }, required: ['username'] } },
  { name: 'medium_fetch', description: 'Fetch a Medium RSS feed by full URL (host must be on medium.com).',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, limit: { type: 'number' }, full: { type: 'boolean' } }, required: ['url'] } },
];

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const strip = (h = '') => h.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const pick = (b, t) => { const m = b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i')); return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : ''; };

async function fetchFeed(url, limit = 10, full = false) {
  const res = await fetch(url, { headers: { 'User-Agent': 'medium-rss-mcp/1.0' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const xml = await res.text();
  const all = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const b = m[1];
    const text = strip(pick(b, 'content:encoded') || pick(b, 'description'));
    const categories = [...b.matchAll(/<category>([\s\S]*?)<\/category>/g)].map((c) => c[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim());
    return { title: strip(pick(b, 'title')), link: pick(b, 'link'), pubDate: pick(b, 'pubDate'), categories, content: full ? text : text.slice(0, 500) };
  });
  all.sort((x, y) => (Date.parse(y.pubDate) || 0) - (Date.parse(x.pubDate) || 0)); // newest first
  return all.slice(0, Math.max(1, Math.min(limit, 30)));
}

function feedUrl(a) {
  if (a.url) { const u = new URL(a.url); if (!/(^|\.)medium\.com$/.test(u.hostname)) throw new Error('url host must be medium.com'); return u.href; }
  if (a.tag) return `https://medium.com/feed/tag/${encodeURIComponent(String(a.tag).trim().toLowerCase().replace(/\s+/g, '-'))}`;
  if (a.username) return `https://medium.com/feed/@${encodeURIComponent(String(a.username).replace(/^@/, ''))}`;
  throw new Error('provide tag, username, or url');
}

async function callTool(_name, args = {}) {
  const url = feedUrl(args);
  const items = await fetchFeed(url, args.limit ?? 10, !!args.full);
  return { content: [{ type: 'text', text: JSON.stringify({ source: url, count: items.length, items }, null, 2) }] };
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  line = line.trim(); if (!line) return;
  let req; try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  try {
    if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: PROTO, capabilities: { tools: {} }, serverInfo: SERVER } });
    if (method && method.startsWith('notifications/')) return;
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') return send({ jsonrpc: '2.0', id, result: await callTool(params.name, params.arguments || {}) });
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(e?.message || e) } });
  }
});
process.stderr.write('medium-rss-mcp running on stdio\n');
