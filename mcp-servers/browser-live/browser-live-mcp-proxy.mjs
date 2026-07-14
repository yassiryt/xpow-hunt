#!/usr/bin/env node

import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');

const argv = process.argv.slice(2);
const separatorIndex = argv.indexOf('--');

if (separatorIndex === -1 || separatorIndex === argv.length - 1) {
  process.stderr.write(
    'Usage: node browser-live-mcp-proxy.mjs -- <child-command> [args...]\n',
  );
  process.exit(64);
}

const childCommand = argv[separatorIndex + 1];
const childArgs = argv.slice(separatorIndex + 2);

const PROXY_LOG_FILE = process.env.BROWSER_LIVE_MCP_PROXY_LOG_FILE;
const LOG_RAW_HOST_REQUESTS =
  process.env.BROWSER_LIVE_MCP_PROXY_LOG_RAW_HOST_REQUESTS === '1';
const GLOBAL_TIMEOUT_MS = readIntEnv(
  ['MCP_PROXY_REQUEST_TIMEOUT_MS', 'BROWSER_LIVE_MCP_PROXY_REQUEST_TIMEOUT_MS'],
  180000,
);
const TOOLS_CALL_TIMEOUT_MS = readIntEnv(
  ['MCP_PROXY_TOOL_TIMEOUT_MS', 'BROWSER_LIVE_MCP_PROXY_TOOL_TIMEOUT_MS'],
  90000,
);
const GET_NETWORK_REQUEST_TIMEOUT_MS = readIntEnv(
  [
    'MCP_PROXY_GET_NETWORK_REQUEST_TIMEOUT_MS',
    'BROWSER_LIVE_MCP_PROXY_GET_NETWORK_REQUEST_TIMEOUT_MS',
  ],
  20000,
);
const NAVIGATION_TIMEOUT_MS = readIntEnv(
  [
    'MCP_PROXY_NAVIGATION_TIMEOUT_MS',
    'BROWSER_LIVE_MCP_PROXY_NAVIGATION_TIMEOUT_MS',
  ],
  45000,
);
const WAIT_FOR_TIMEOUT_MS = readIntEnv(
  ['MCP_PROXY_WAIT_FOR_TIMEOUT_MS', 'BROWSER_LIVE_MCP_PROXY_WAIT_FOR_TIMEOUT_MS'],
  45000,
);
const INPUT_TIMEOUT_MS = readIntEnv(
  ['MCP_PROXY_INPUT_TIMEOUT_MS', 'BROWSER_LIVE_MCP_PROXY_INPUT_TIMEOUT_MS'],
  30000,
);
const SNAPSHOT_TIMEOUT_MS = readIntEnv(
  [
    'MCP_PROXY_SNAPSHOT_TIMEOUT_MS',
    'BROWSER_LIVE_MCP_PROXY_SNAPSHOT_TIMEOUT_MS',
  ],
  30000,
);
const REQUEST_TIMEOUT_SLACK_MS = readIntEnv(
  [
    'MCP_PROXY_REQUEST_TIMEOUT_SLACK_MS',
    'BROWSER_LIVE_MCP_PROXY_REQUEST_TIMEOUT_SLACK_MS',
  ],
  10000,
);
const RESTART_DELAY_MS = readIntEnv(
  ['MCP_PROXY_RESTART_DELAY_MS', 'BROWSER_LIVE_MCP_PROXY_RESTART_DELAY_MS'],
  250,
);
const KILL_GRACE_MS = readIntEnv(
  ['MCP_PROXY_KILL_GRACE_MS', 'BROWSER_LIVE_MCP_PROXY_KILL_GRACE_MS'],
  1500,
);
const WORKSPACE_PATH = process.env.BROWSER_LIVE_WORKSPACE_PATH || process.cwd();
const CLAUDE_PROJECTS_DIR =
  process.env.BROWSER_LIVE_CLAUDE_PROJECTS_DIR ||
  path.join(os.homedir(), '.claude', 'projects');
const TRANSCRIPT_CACHE_TTL_MS = readIntEnv(
  [
    'BROWSER_LIVE_AGENT_TRANSCRIPT_CACHE_TTL_MS',
    'MCP_PROXY_AGENT_TRANSCRIPT_CACHE_TTL_MS',
  ],
  5000,
);
const TRANSCRIPT_SCAN_LIMIT = readIntEnv(
  [
    'BROWSER_LIVE_AGENT_TRANSCRIPT_SCAN_LIMIT',
    'MCP_PROXY_AGENT_TRANSCRIPT_SCAN_LIMIT',
  ],
  40,
);
const OWNER_RESOLUTION_WAIT_MS = readIntEnv(
  [
    'BROWSER_LIVE_AGENT_OWNER_RESOLUTION_WAIT_MS',
    'MCP_PROXY_AGENT_OWNER_RESOLUTION_WAIT_MS',
  ],
  1500,
);
const OWNER_RESOLUTION_POLL_MS = readIntEnv(
  [
    'BROWSER_LIVE_AGENT_OWNER_RESOLUTION_POLL_MS',
    'MCP_PROXY_AGENT_OWNER_RESOLUTION_POLL_MS',
  ],
  25,
);
const BROWSER_TARGET_FETCH_TIMEOUT_MS = readIntEnv(
  [
    'BROWSER_LIVE_CDP_TARGET_FETCH_TIMEOUT_MS',
    'MCP_PROXY_CDP_TARGET_FETCH_TIMEOUT_MS',
  ],
  2500,
);
const DIALOG_RECOVERY_GRACE_MS = readIntEnv(
  [
    'BROWSER_LIVE_DIALOG_RECOVERY_GRACE_MS',
    'MCP_PROXY_DIALOG_RECOVERY_GRACE_MS',
  ],
  7000,
);
const DIALOG_RISK_WINDOW_MS = readIntEnv(
  [
    'BROWSER_LIVE_DIALOG_RISK_WINDOW_MS',
    'MCP_PROXY_DIALOG_RISK_WINDOW_MS',
  ],
  180000,
);

const BROWSER_VERSION_URL = normalizeBrowserVersionUrl(
  readCliFlagValue(childArgs, '--browser-url'),
);
const BROWSER_LIST_URL = deriveBrowserListUrl(BROWSER_VERSION_URL);

let child = null;
let childGeneration = 0;
let startTimer = null;
let stopRequested = false;
let restartReason = '';
let replayInitTimer = null;
let replayInitInFlight = false;
let childReady = false;
let hostInitReplied = false;
let messageOrder = 0;
let hostFraming = null;

const pendingRequests = new Map();
const suppressedIdsByGeneration = new Map();
const childFramingByGeneration = new Map();
const queuedMessages = [];
const pageOwners = new Map();
const pageMetadata = new Map();
const pageTargets = new Map();
const targetPages = new Map();
const dialogRiskByPage = new Map();
const ownerStates = new Map();
const toolUseOwnerCache = new Map();

let transcriptFileCacheAt = 0;
let transcriptFileCache = [];
let knownBrowserWsUrl = '';
let knownTargetIds = new Set();

let cachedInitialize = null;
let cachedInitializedNotification = null;

const FRAMING_CONTENT_LENGTH = 'content-length';
const FRAMING_NEWLINE = 'newline';
const DEFAULT_CHILD_FRAMING = FRAMING_NEWLINE;

class FrameParser {
  constructor(name, onFrame) {
    this.name = name;
    this.onFrame = onFrame;
    this.buffer = Buffer.alloc(0);
    this.framing = null;
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) {
      return;
    }

    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length > 0) {
      if (this.framing === FRAMING_CONTENT_LENGTH) {
        if (!this.#drainContentLengthFrame()) {
          return;
        }
        continue;
      }

      if (this.framing === FRAMING_NEWLINE) {
        if (!this.#drainNewlineFrame()) {
          return;
        }
        continue;
      }

      if (!this.#drainUnknownFrame()) {
        return;
      }
    }
  }

  #emit(json, framing) {
    if (!this.framing) {
      this.framing = framing;
      log(`${this.name} framing detected: ${framing}`);
    }
    this.onFrame({ json, framing });
  }

  #drainUnknownFrame() {
    const marker = findHeaderMarker(this.buffer);
    if (marker) {
      this.framing = FRAMING_CONTENT_LENGTH;
      return this.#drainContentLengthFrame();
    }

    const lineIndex = this.buffer.indexOf('\n');
    if (lineIndex === -1) {
      return false;
    }

    const line = stripTrailingCarriageReturn(
      this.buffer.subarray(0, lineIndex).toString('utf8'),
    );
    this.buffer = this.buffer.subarray(lineIndex + 1);

    if (line.trim() === '') {
      return true;
    }

    if (/^content-length:/i.test(line)) {
      this.buffer = Buffer.concat([
        Buffer.from(`${line}\n`, 'utf8'),
        this.buffer,
      ]);
      return false;
    }

    try {
      this.#emit(JSON.parse(line), FRAMING_NEWLINE);
    } catch (error) {
      log(`dropping malformed newline frame from ${this.name}: ${error.message}`);
    }

    return true;
  }

  #drainContentLengthFrame() {
    const marker = findHeaderMarker(this.buffer);
    if (!marker) {
      return false;
    }

    const headerText = this.buffer.subarray(0, marker.index).toString('ascii');
    const match = /(?:^|\r?\n)content-length:\s*(\d+)\s*(?:\r?\n|$)/i.exec(
      headerText,
    );

    if (!match) {
      log(`dropping malformed frame from ${this.name}: missing Content-Length`);
      this.buffer = this.buffer.subarray(marker.index + marker.length);
      return true;
    }

    const contentLength = Number.parseInt(match[1], 10);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      log(`dropping malformed frame from ${this.name}: bad Content-Length`);
      this.buffer = this.buffer.subarray(marker.index + marker.length);
      return true;
    }

    const frameLength = marker.index + marker.length + contentLength;
    if (this.buffer.length < frameLength) {
      return false;
    }

    const body = this.buffer.subarray(marker.index + marker.length, frameLength);
    this.buffer = this.buffer.subarray(frameLength);

    try {
      this.#emit(JSON.parse(body.toString('utf8')), FRAMING_CONTENT_LENGTH);
    } catch (error) {
      log(`non-JSON frame from ${this.name}: ${error.message}`);
    }

    return true;
  }

  #drainNewlineFrame() {
    const lineIndex = this.buffer.indexOf('\n');
    if (lineIndex === -1) {
      return false;
    }

    const line = stripTrailingCarriageReturn(
      this.buffer.subarray(0, lineIndex).toString('utf8'),
    );
    this.buffer = this.buffer.subarray(lineIndex + 1);

    if (line.trim() === '') {
      return true;
    }

    try {
      this.#emit(JSON.parse(line), FRAMING_NEWLINE);
    } catch (error) {
      log(`dropping malformed newline frame from ${this.name}: ${error.message}`);
    }

    return true;
  }
}

process.stdin.on('data', (chunk) => hostParser.push(chunk));
process.stdin.on('end', () => {
  stopRequested = true;
  clearTimeout(startTimer);
  clearReplayInitTimer();
  if (child && child.exitCode === null && !child.killed) {
    child.kill('SIGTERM');
  }
});
process.stdin.resume();

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const hostParser = new FrameParser('host', handleHostFrame);
void primeBrowserTargetSnapshot();

function handleHostFrame(message) {
  if (!hostFraming) {
    hostFraming = message.framing;
  }

  const order = ++messageOrder;
  let item = buildHostItem(message, order);

  if (item.type !== 'immediate_response') {
    const isolated = applyAgentIsolationToHostItem(item);
    if (isolated) {
      item = isolated;
    }
  }

  if (isRequest(item.json)) {
    log(`host request id=${String(item.json.id)} method=${item.json.method}`);
    if (LOG_RAW_HOST_REQUESTS) {
      log(`host request payload=${safeJson(item.json)}`);
    }
  }

  if (item.type === 'request' && item.method === 'tools/call') {
    recordPotentialDialogRisk(item);
  }

  if (item.type === 'immediate_response') {
    process.stdout.write(encodeForHost(item.json));
    return;
  }

  if (item.type === 'request') {
    if (pendingRequests.has(item.key)) {
      const previous = pendingRequests.get(item.key);
      clearRequestTimer(previous);
      pendingRequests.delete(item.key);
      removeQueuedItem(previous);
      log(`replacing duplicate in-flight request id=${String(item.id)}`);
    }
    pendingRequests.set(item.key, item);
    armRequestTimer(item);
  }

  if (item.method === 'initialize') {
    cachedInitialize = item;
  } else if (item.json?.method === 'notifications/initialized') {
    cachedInitializedNotification = item;
  }

  if (!child && !startTimer && !stopRequested) {
    startChild(`host ${item.method ?? 'message'}`);
  }

  if (!canSendToChild()) {
    enqueueMessage(item);
    return;
  }

  sendHostItemToChild(item);
}

function buildHostItem(message, order) {
  let { json } = message;

  const normalized = normalizeHostRequest(json, order);
  if (normalized) {
    if (normalized.type === 'immediate_response') {
      return normalized;
    }
    json = normalized.json;
  }

  if (isRequest(json)) {
    const item = {
      type: 'request',
      json,
      id: json.id,
      key: makeIdKey(json.id),
      method: json.method,
      order,
      timeoutMs: requestTimeoutFor(json),
      timer: null,
      state: 'queued',
      generation: 0,
    };
    return item;
  }

  return {
    type: 'other',
    json,
    order,
  };
}

function applyAgentIsolationToHostItem(item) {
  if (item.type !== 'request' || item.method !== 'tools/call') {
    return null;
  }

  const toolName = safeString(item.json?.params?.name);
  const args = getToolArguments(item.json);
  const toolUseId = safeString(
    item.json?.params?._meta?.['claudecode/toolUseId'],
  );
  if (!toolName || !args) {
    return null;
  }

  const callContext = resolveCallContext(item.json);
  if (!callContext) {
    // Fallback: skip agent isolation instead of failing when owner cannot be resolved.
    // This allows single-agent sessions to work even when the transcript has not been
    // flushed before the tool call reaches the proxy.
    log(`owner resolution failed for toolUseId ${toolUseId} – falling back to passthrough`);
    return null;
  }

  const ownerState = getOwnerState(callContext.ownerKey);
  let normalizedArgs = args;
  let effectivePageId = null;

  const setArg = (key, value) => {
    if (Object.is(normalizedArgs[key], value)) {
      return;
    }
    if (normalizedArgs === args) {
      normalizedArgs = { ...args };
    }
    normalizedArgs[key] = value;
  };

  if (toolName === 'new_page') {
    if (
      typeof normalizedArgs.isolatedContext !== 'string' ||
      normalizedArgs.isolatedContext.trim() === ''
    ) {
      setArg('isolatedContext', callContext.ownerContextName);
    }
  } else if (toolName === 'list_pages') {
    // Response filtering happens after the upstream tool returns.
  } else if (toolName === 'select_page' || toolName === 'close_page') {
    effectivePageId = readPositiveIntValue(normalizedArgs.pageId);
    if (effectivePageId == null) {
      return immediateToolError(
        item,
        `${toolName} requires a numeric pageId.`,
      );
    }
    if (!canOwnerAccessPage(callContext.ownerKey, effectivePageId)) {
      return immediateToolError(
        item,
        `Page ${effectivePageId} is owned by another agent. Create a new page or use one of your own pages instead.`,
      );
    }
  } else if (toolName === 'navigate_page' && !hasNumericPageId(normalizedArgs)) {
    effectivePageId = inferOwnerPageId(callContext.ownerKey, ownerState);
    if (effectivePageId == null) {
      if (typeof normalizedArgs.url !== 'string' || normalizedArgs.url.trim() === '') {
        return immediateToolError(
          item,
          'navigate_page requires a target URL and an owned page. Call new_page first if you do not own a page yet.',
        );
      }

      if (
        typeof normalizedArgs.isolatedContext !== 'string' ||
        normalizedArgs.isolatedContext.trim() === ''
      ) {
        setArg('isolatedContext', callContext.ownerContextName);
      }

      item = replaceToolCall(item, 'new_page', normalizedArgs);
      item.callContext = {
        ...callContext,
        effectivePageId: null,
        convertedFrom: 'navigate_page',
      };
      item.timeoutMs = requestTimeoutFor(item.json);
      log(
        `converted navigate_page to new_page for ${callContext.ownerKey} because no owned page was selected`,
      );
      return item;
    }
  } else if (requiresOwnedPage(toolName)) {
    effectivePageId =
      readPositiveIntValue(normalizedArgs.pageId) ??
      inferOwnerPageId(callContext.ownerKey, ownerState);

    if (effectivePageId == null) {
      return immediateToolError(
        item,
        'No owned page is selected for this agent. Call new_page to create an agent-isolated page, or list_pages to inspect your current pages.',
      );
    }

    if (!canOwnerAccessPage(callContext.ownerKey, effectivePageId)) {
      return immediateToolError(
        item,
        `Page ${effectivePageId} is owned by another agent. Create a new page or use one of your own pages instead.`,
      );
    }

    if (!hasNumericPageId(normalizedArgs)) {
      setArg('pageId', effectivePageId);
      log(
        `bound ${toolName} for ${callContext.ownerKey} to owned page ${String(effectivePageId)}`,
      );
    }
  }

  const selectedPageId =
    effectivePageId ??
    (hasNumericPageId(normalizedArgs)
      ? readPositiveIntValue(normalizedArgs.pageId)
      : null);

  if (normalizedArgs !== args) {
    item = replaceToolCall(item, toolName, normalizedArgs);
    item.timeoutMs = requestTimeoutFor(item.json);
  }

  item.callContext = {
    ...callContext,
    effectivePageId: selectedPageId,
  };

  return item;
}

function resolveCallContext(json) {
  const toolUseId = safeString(
    json?.params?._meta?.['claudecode/toolUseId'],
  );
  if (!toolUseId) {
    return null;
  }

  const owner = resolveOwnerForToolUseId(toolUseId);
  if (!owner) {
    return null;
  }

  return {
    ...owner,
    toolUseId,
    ownerContextName: contextNameForOwner(owner.ownerKey),
  };
}

function resolveOwnerForToolUseId(toolUseId) {
  if (toolUseOwnerCache.has(toolUseId)) {
    return toolUseOwnerCache.get(toolUseId);
  }

  const resolved = scanTranscriptsForToolUseId(toolUseId);
  if (resolved) {
    return resolved;
  }

  if (OWNER_RESOLUTION_WAIT_MS <= 0) {
    return null;
  }

  const deadline = Date.now() + OWNER_RESOLUTION_WAIT_MS;
  while (Date.now() < deadline) {
    sleepSync(Math.min(OWNER_RESOLUTION_POLL_MS, deadline - Date.now()));
    const owner = scanTranscriptsForToolUseId(toolUseId, {
      forceRefreshFiles: true,
    });
    if (owner) {
      log(`resolved toolUseId ${toolUseId} after waiting for transcript flush`);
      return owner;
    }
  }

  log(
    `could not resolve toolUseId ${toolUseId} within ${OWNER_RESOLUTION_WAIT_MS}ms`,
  );
  return null;
}

function scanTranscriptsForToolUseId(toolUseId, options = {}) {
  for (const filePath of getTranscriptFiles(options)) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    if (!content.includes(toolUseId)) {
      continue;
    }

    for (const line of content.split('\n')) {
      if (!line.includes(toolUseId)) {
        continue;
      }

      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      const owner = ownerFromTranscriptRecord(record, filePath);
      if (!owner) {
        continue;
      }

      toolUseOwnerCache.set(toolUseId, owner);
      log(`resolved toolUseId ${toolUseId} to ${owner.ownerKey}`);
      return owner;
    }
  }

  return null;
}

function getTranscriptFiles(options = {}) {
  const now = Date.now();
  const forceRefreshFiles = options.forceRefreshFiles === true;
  if (
    !forceRefreshFiles &&
    now - transcriptFileCacheAt < TRANSCRIPT_CACHE_TTL_MS &&
    transcriptFileCache.length
  ) {
    return transcriptFileCache;
  }

  const projectDir = path.join(
    CLAUDE_PROJECTS_DIR,
    workspaceToProjectSlug(WORKSPACE_PATH),
  );

  const files = [];
  walkTranscriptFiles(projectDir, files);
  files.sort((left, right) => {
    try {
      return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
    } catch {
      return 0;
    }
  });

  transcriptFileCache = files.slice(0, TRANSCRIPT_SCAN_LIMIT);
  transcriptFileCacheAt = now;
  return transcriptFileCache;
}

function sleepSync(delayMs) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return;
  }
  const shared = new SharedArrayBuffer(4);
  const signal = new Int32Array(shared);
  Atomics.wait(signal, 0, 0, delayMs);
}

function walkTranscriptFiles(dirPath, files) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkTranscriptFiles(fullPath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(fullPath);
    }
  }
}

function workspaceToProjectSlug(workspacePath) {
  return workspacePath.replace(/[\\/]/g, '-');
}

function ownerFromTranscriptRecord(record, transcriptPath) {
  const agentId = safeString(record.agentId) || safeString(record.data?.agentId);
  const sessionId =
    safeString(record.sessionId) || safeString(record.data?.sessionId);

  if (agentId) {
    return {
      ownerKey: `agent:${agentId}`,
      ownerType: 'agent',
      sessionId,
      agentId,
      transcriptPath,
    };
  }

  if (sessionId) {
    return {
      ownerKey: `root:${sessionId}`,
      ownerType: 'root',
      sessionId,
      agentId: null,
      transcriptPath,
    };
  }

  return null;
}

function contextNameForOwner(ownerKey) {
  return `claude-${ownerKey.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

function getOwnerState(ownerKey) {
  let state = ownerStates.get(ownerKey);
  if (!state) {
    state = {
      selectedPageId: null,
      pageIds: new Set(),
    };
    ownerStates.set(ownerKey, state);
  }
  return state;
}

function requiresOwnedPage(toolName) {
  return ![
    'list_pages',
    'new_page',
    'select_page',
    'close_page',
    'install_extension',
    'uninstall_extension',
    'list_extensions',
    'reload_extension',
    'trigger_extension_action',
  ].includes(toolName);
}

function canOwnerAccessPage(ownerKey, pageId) {
  if (isRootOwner(ownerKey)) {
    return true;
  }
  return pageOwners.get(pageId) === ownerKey;
}

function inferOwnerPageId(ownerKey, ownerState) {
  if (ownerState.selectedPageId != null) {
    return ownerState.selectedPageId;
  }
  if (ownerState.pageIds.size === 1) {
    return [...ownerState.pageIds][0];
  }
  return null;
}

function hasNumericPageId(args) {
  return readPositiveIntValue(args?.pageId) != null;
}

function isRootOwner(ownerKey) {
  return ownerKey.startsWith('root:');
}

function immediateToolError(item, message) {
  return {
    type: 'immediate_response',
    json: {
      jsonrpc: '2.0',
      id: item.id,
      error: {
        code: -32002,
        message,
        data: {
          method: safeString(item.json?.params?.name),
        },
      },
    },
  };
}

function replaceToolCall(item, toolName, args) {
  return {
    ...item,
    json: {
      ...item.json,
      params: {
        ...item.json.params,
        name: toolName,
        arguments: args,
      },
    },
  };
}

function sendHostItemToChild(item) {
  if (!child || child.exitCode !== null || child.killed || !child.stdin.writable) {
    enqueueMessage(item);
    return;
  }

  child.stdin.write(encodeForChild(item.json, childGeneration));

  if (item.type === 'request') {
    item.state = 'pending';
    item.generation = childGeneration;
  }
}

function handleChildFrame(generation, message) {
  if (generation !== childGeneration) {
    return;
  }

  childFramingByGeneration.set(generation, message.framing);

  let { json } = message;

  if (
    replayInitInFlight &&
    isResponse(json) &&
    cachedInitialize &&
    makeIdKey(json.id) === cachedInitialize.key
  ) {
    clearReplayInitTimer();
    replayInitInFlight = false;
    childReady = true;

    if (cachedInitializedNotification) {
      child.stdin.write(
        encodeForChild(cachedInitializedNotification.json, generation),
      );
    }

    flushQueue();
    return;
  }

  if (isResponse(json)) {
    const key = makeIdKey(json.id);
    const suppressed = suppressedIdsByGeneration.get(generation);
    if (suppressed && suppressed.has(key)) {
      return;
    }

    const pending = pendingRequests.get(key);
    if (pending) {
      void trackPageStateFromResponse(pending, json).catch((error) => {
        log(`page state tracking failed: ${error.message}`);
      });
      void maybeRecoverAfterChildError(pending, json).catch((error) => {
        log(`dialog recovery after child error failed: ${error.message}`);
      });

      const isolated = applyAgentIsolationToResponse(pending, json);
      if (isolated !== json) {
        json = isolated;
      }

      const augmented = augmentToolResponse(pending, json);
      if (augmented !== json) {
        json = augmented;
      }

      clearRequestTimer(pending);
      pendingRequests.delete(key);
      pending.state = 'done';

      if (pending.method === 'initialize') {
        hostInitReplied = true;
      }

      log(
        `child response id=${String(json.id)} to=${pending.method} gen=${generation}`,
      );
    }
  }

  process.stdout.write(encodeForHost(json));
}

function applyAgentIsolationToResponse(pending, json) {
  if (!pending?.callContext || !isResponse(json) || json?.error) {
    return json;
  }

  const ownerKey = pending.callContext.ownerKey;
  const toolName = safeString(pending.json?.params?.name);
  const args = getToolArguments(pending.json) || {};
  const effectivePageId = pending.callContext.effectivePageId;

  if (toolName === 'new_page') {
    assignNewPageToOwner(ownerKey, json, args, pending.callContext.ownerContextName);
  } else if (toolName === 'close_page' && effectivePageId != null) {
    releasePageFromOwner(effectivePageId);
  } else if (
    effectivePageId != null &&
    (toolName === 'select_page' || requiresOwnedPage(toolName))
  ) {
    selectOwnerPage(ownerKey, effectivePageId);
  }

  const structuredPages = getStructuredPages(json);
  if (!structuredPages) {
    return json;
  }

  updatePageMetadata(structuredPages);
  void reconcilePageTargetsForResponse({
    ownerKey,
    toolName,
    args,
    pages: structuredPages,
  }).catch((error) => {
    log(`page target reconciliation failed: ${error.message}`);
  });

  const visiblePages = filterVisiblePages(ownerKey, structuredPages);
  const renderedPages = visiblePages.map((page) => {
    if (isRootOwner(ownerKey)) {
      return page;
    }
    return {
      ...page,
      selected: getOwnerState(ownerKey).selectedPageId === page.id,
    };
  });

  return rewritePagesInResponse(json, renderedPages, ownerKey);
}

function assignNewPageToOwner(ownerKey, json, args, ownerContextName) {
  const pages = getStructuredPages(json);
  if (!pages || pages.length === 0) {
    return;
  }

  let candidate = null;
  if (typeof args.isolatedContext === 'string' && args.isolatedContext.trim() !== '') {
    candidate =
      pages.find(
        (page) =>
          page.isolatedContext === args.isolatedContext &&
          !pageOwners.has(page.id) &&
          page.selected,
      ) ??
      pages.find(
        (page) =>
          page.isolatedContext === args.isolatedContext && !pageOwners.has(page.id),
      );
  }

  if (!candidate && ownerContextName) {
    candidate =
      pages.find(
        (page) =>
          page.isolatedContext === ownerContextName &&
          !pageOwners.has(page.id) &&
          page.selected,
      ) ??
      pages.find(
        (page) =>
          page.isolatedContext === ownerContextName && !pageOwners.has(page.id),
      );
  }

  if (!candidate) {
    candidate =
      pages.find((page) => !pageOwners.has(page.id) && page.selected) ??
      pages.find((page) => !pageOwners.has(page.id)) ??
      null;
  }

  if (!candidate) {
    return;
  }

  pageOwners.set(candidate.id, ownerKey);
  const ownerState = getOwnerState(ownerKey);
  ownerState.pageIds.add(candidate.id);
  ownerState.selectedPageId = candidate.id;
  pageMetadata.set(candidate.id, {
    url: candidate.url,
    isolatedContext: candidate.isolatedContext ?? null,
  });
  log(`assigned page ${String(candidate.id)} to ${ownerKey}`);
}

function releasePageFromOwner(pageId) {
  const previousOwner = pageOwners.get(pageId);
  if (previousOwner) {
    const ownerState = getOwnerState(previousOwner);
    ownerState.pageIds.delete(pageId);
    if (ownerState.selectedPageId === pageId) {
      ownerState.selectedPageId = ownerState.pageIds.size
        ? [...ownerState.pageIds][0]
        : null;
    }
  }
  pageOwners.delete(pageId);
  pageMetadata.delete(pageId);
  releasePageTarget(pageId);
  dialogRiskByPage.delete(pageId);
}

function selectOwnerPage(ownerKey, pageId) {
  const ownerState = getOwnerState(ownerKey);
  if (!isRootOwner(ownerKey)) {
    ownerState.pageIds.add(pageId);
  }
  ownerState.selectedPageId = pageId;
}

function getStructuredPages(json) {
  const pages = json?.result?.structuredContent?.pages;
  if (Array.isArray(pages)) {
    return pages
      .map((page) => {
        const id = readPositiveIntValue(page?.id);
        if (id == null) {
          return null;
        }
        return {
          id,
          url: safeString(page?.url),
          selected: page?.selected === true,
          isolatedContext: safeString(page?.isolatedContext) || null,
        };
      })
      .filter(Boolean);
  }

  return parsePagesFromTextResult(json?.result) ?? null;
}

function updatePageMetadata(pages) {
  for (const page of pages) {
    pageMetadata.set(page.id, {
      url: page.url,
      isolatedContext: page.isolatedContext,
    });
  }
}

function filterVisiblePages(ownerKey, pages) {
  if (isRootOwner(ownerKey)) {
    return pages;
  }
  return pages.filter((page) => pageOwners.get(page.id) === ownerKey);
}

function rewritePagesInResponse(json, pages, ownerKey) {
  const structuredContent =
    json?.result?.structuredContent &&
    typeof json.result.structuredContent === 'object'
      ? { ...json.result.structuredContent }
      : {};

  structuredContent.pages = pages.map((page) => ({
    id: page.id,
    url: page.url,
    selected: page.selected,
    ...(page.isolatedContext ? { isolatedContext: page.isolatedContext } : {}),
  }));

  const content = Array.isArray(json?.result?.content)
    ? json.result.content.map((entry) => {
        if (entry?.type !== 'text' || typeof entry.text !== 'string') {
          return entry;
        }
        return {
          ...entry,
          text: replacePagesSection(entry.text, pages, ownerKey),
        };
      })
    : json?.result?.content;

  return {
    ...json,
    result: {
      ...json.result,
      content,
      structuredContent,
    },
  };
}

function replacePagesSection(text, pages, ownerKey) {
  const lines = String(text).split('\n');
  const rendered = renderPagesLines(pages, ownerKey);
  const output = [];

  let index = 0;
  let replaced = false;
  while (index < lines.length) {
    const line = lines[index];
    if (line === '## Pages') {
      output.push(...rendered);
      replaced = true;
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index];
        if (candidate.startsWith('## ') && candidate !== '## Pages') {
          break;
        }
        if (
          candidate.trim() === '' ||
          /^\d+:\s/.test(candidate) ||
          candidate.startsWith('(no pages owned')
        ) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }

    output.push(line);
    index += 1;
  }

  if (!replaced) {
    if (output.length > 0 && output[output.length - 1] !== '') {
      output.push('');
    }
    output.push(...rendered);
  }

  return output.join('\n');
}

function renderPagesLines(pages, ownerKey) {
  const lines = ['## Pages'];
  if (pages.length === 0) {
    lines.push(
      isRootOwner(ownerKey)
        ? '(no open pages)'
        : '(no pages owned by this agent)',
    );
    return lines;
  }

  for (const page of pages) {
    let line = `${page.id}: ${page.url}`;
    if (page.selected) {
      line += ' [selected]';
    }
    if (page.isolatedContext) {
      line += ` isolatedContext=${page.isolatedContext}`;
    }
    lines.push(line);
  }

  return lines;
}

function parsePagesFromTextResult(result) {
  if (!Array.isArray(result?.content)) {
    return null;
  }

  for (const entry of result.content) {
    if (entry?.type !== 'text' || typeof entry.text !== 'string') {
      continue;
    }

    const pages = parsePagesFromText(entry.text);
    if (pages.length > 0) {
      return pages;
    }
  }

  return null;
}

function parsePagesFromText(text) {
  const lines = String(text).split('\n');
  const pages = [];

  let inPages = false;
  for (const line of lines) {
    if (line === '## Pages') {
      inPages = true;
      continue;
    }
    if (!inPages) {
      continue;
    }
    if (line.startsWith('## ') && line !== '## Pages') {
      break;
    }
    const match = /^(\d+):\s+(\S+)(?:\s+\[selected\])?(?:\s+isolatedContext=(\S+))?$/.exec(
      line.trim(),
    );
    if (!match) {
      if (line.trim() === '') {
        continue;
      }
      break;
    }
    pages.push({
      id: Number.parseInt(match[1], 10),
      url: match[2],
      selected: line.includes('[selected]'),
      isolatedContext: match[3] ?? null,
    });
  }

  return pages;
}

function armRequestTimer(item) {
  item.timer = setTimeout(() => {
    handleRequestTimeout(item);
  }, item.timeoutMs);

  if (typeof item.timer.unref === 'function') {
    item.timer.unref();
  }
}

function clearRequestTimer(item) {
  if (item?.timer) {
    clearTimeout(item.timer);
    item.timer = null;
  }
}

function handleRequestTimeout(item) {
  void handleRequestTimeoutAsync(item);
}

async function handleRequestTimeoutAsync(item) {
  const current = pendingRequests.get(item.key);
  if (current !== item) {
    return;
  }

  if (await maybeRecoverTimedOutRequest(item)) {
    return;
  }

  pendingRequests.delete(item.key);
  clearRequestTimer(item);
  removeQueuedItem(item);

  const stateAtTimeout = item.state;
  const generationAtTimeout = item.generation;

  if (stateAtTimeout === 'pending' && generationAtTimeout === childGeneration) {
    suppressResponse(generationAtTimeout, item.key);
  }

  writeJsonRpc(process.stdout, {
    jsonrpc: '2.0',
    id: item.id,
    error: {
      code: -32001,
      message: `Proxy timed out ${item.method} after ${item.timeoutMs}ms and restarted the upstream MCP server.`,
      data: {
        method: item.method,
        timeout_ms: item.timeoutMs,
        tool_name:
          item.method === 'tools/call' ? safeString(item.json?.params?.name) : null,
      },
    },
  });

  log(
    `request timeout id=${String(item.id)} method=${item.method} timeout=${item.timeoutMs}ms state=${stateAtTimeout}`,
  );

  if (stateAtTimeout === 'pending' && generationAtTimeout === childGeneration) {
    salvagePendingRequestsAfterTimeout(item);
  }

  requestRestart(
    `timeout on ${item.method} id=${String(item.id)} after ${item.timeoutMs}ms`,
  );
}

function salvagePendingRequestsAfterTimeout(timedOutItem) {
  const retryable = [];
  const failed = [];

  for (const other of pendingRequests.values()) {
    if (other.state !== 'pending' || other.generation !== timedOutItem.generation) {
      continue;
    }

    if (other.method === 'initialize' && !hostInitReplied) {
      retryable.push(other);
      continue;
    }

    if (other.order > timedOutItem.order) {
      retryable.push(other);
      continue;
    }

    failed.push(other);
  }

  for (const item of retryable) {
    pendingRequests.delete(item.key);
    suppressResponse(item.generation, item.key);
    item.state = 'queued';
    item.generation = 0;
  }

  if (retryable.length > 0) {
    enqueueMessages(retryable);
  }

  for (const item of failed) {
    pendingRequests.delete(item.key);
    clearRequestTimer(item);
    suppressResponse(item.generation, item.key);
    item.state = 'done';

    writeJsonRpc(process.stdout, {
      jsonrpc: '2.0',
      id: item.id,
      error: {
        code: -32002,
        message:
          'Proxy restarted the upstream MCP server before this request completed. Retry the request.',
        data: {
          method: item.method,
          reason: 'upstream_restart_after_timeout',
        },
      },
    });
  }
}

function requestRestart(reason) {
  if (stopRequested) {
    return;
  }

  restartReason = reason;
  childReady = false;
  clearReplayInitTimer();

  if (!child || child.exitCode !== null || child.killed) {
    scheduleStart(reason);
    return;
  }

  log(`restarting child: ${reason}`);
  const proc = child;

  try {
    proc.kill('SIGTERM');
  } catch (error) {
    log(`failed to SIGTERM child: ${error.message}`);
    scheduleStart(reason);
    return;
  }

  setTimeout(() => {
    if (child === proc && proc.exitCode === null && !proc.killed) {
      try {
        proc.kill('SIGKILL');
      } catch (error) {
        log(`failed to SIGKILL child: ${error.message}`);
      }
    }
  }, KILL_GRACE_MS).unref?.();
}

function scheduleStart(reason) {
  if (stopRequested || startTimer) {
    return;
  }

  startTimer = setTimeout(() => {
    startTimer = null;
    startChild(reason);
  }, RESTART_DELAY_MS);

  if (typeof startTimer.unref === 'function') {
    startTimer.unref();
  }
}

function startChild(reason) {
  if (stopRequested) {
    return;
  }

  childGeneration += 1;
  childReady = false;
  childFramingByGeneration.delete(childGeneration);

  const generation = childGeneration;
  const proc = spawn(childCommand, childArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child = proc;
  log(`starting child gen=${generation}: ${childCommand} (${reason})`);

  const parser = new FrameParser(`child:${generation}`, (message) =>
    handleChildFrame(generation, message),
  );

  proc.stdout.on('data', (chunk) => parser.push(chunk));
  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line) {
        continue;
      }
      log(`child stderr gen=${generation}: ${line}`);
    }
  });

  proc.on('spawn', () => {
    if (generation !== childGeneration) {
      return;
    }

    if (hostInitReplied && cachedInitialize) {
      replayInitInFlight = true;
      childReady = false;
      proc.stdin.write(encodeForChild(cachedInitialize.json, generation));
      armReplayInitTimer();
      return;
    }

    childReady = true;
    flushQueue();
  });

  proc.on('error', (error) => {
    log(`child process error gen=${generation}: ${error.message}`);
  });

  proc.on('exit', (code, signal) => {
    if (generation !== childGeneration) {
      return;
    }

    clearReplayInitTimer();
    replayInitInFlight = false;
    childReady = false;
    child = null;

    if (stopRequested) {
      return;
    }

    const exitReason =
      restartReason ||
      `child exited code=${code === null ? 'null' : code} signal=${
        signal ?? 'null'
      }`;

    log(`child exit gen=${generation}: ${exitReason}`);

    failPendingRequestsOnUnexpectedExit(generation, restartReason !== '');
    restartReason = '';
    scheduleStart(exitReason);
  });
}

function failPendingRequestsOnUnexpectedExit(generation, timedRestart) {
  const retryable = [];
  const failed = [];

  for (const item of pendingRequests.values()) {
    if (item.state !== 'pending' || item.generation !== generation) {
      continue;
    }

    if (!timedRestart && item.method === 'initialize' && !hostInitReplied) {
      retryable.push(item);
      continue;
    }

    failed.push(item);
  }

  for (const item of retryable) {
    pendingRequests.delete(item.key);
    item.state = 'queued';
    item.generation = 0;
    enqueueMessage(item);
  }

  for (const item of failed) {
    pendingRequests.delete(item.key);
    clearRequestTimer(item);
    suppressResponse(generation, item.key);
    item.state = 'done';

    writeJsonRpc(process.stdout, {
      jsonrpc: '2.0',
      id: item.id,
      error: {
        code: -32003,
        message:
          'Upstream MCP server exited before this request completed. Retry the request.',
        data: {
          method: item.method,
          reason: timedRestart ? 'watchdog_restart' : 'upstream_exit',
        },
      },
    });
  }
}

function flushQueue() {
  if (!canSendToChild()) {
    return;
  }

  while (queuedMessages.length > 0 && canSendToChild()) {
    const item = queuedMessages.shift();
    if (item.type === 'request' && pendingRequests.get(item.key) !== item) {
      continue;
    }
    sendHostItemToChild(item);
  }
}

function enqueueMessage(item) {
  if (!queuedMessages.includes(item)) {
    queuedMessages.push(item);
    queuedMessages.sort((left, right) => left.order - right.order);
  }
}

function enqueueMessages(items) {
  for (const item of items) {
    enqueueMessage(item);
  }
}

function removeQueuedItem(item) {
  const index = queuedMessages.indexOf(item);
  if (index !== -1) {
    queuedMessages.splice(index, 1);
  }
}

function canSendToChild() {
  return Boolean(
    child &&
      childReady &&
      !replayInitInFlight &&
      child.exitCode === null &&
      !child.killed &&
      child.stdin.writable,
  );
}

function suppressResponse(generation, key) {
  let suppressed = suppressedIdsByGeneration.get(generation);
  if (!suppressed) {
    suppressed = new Set();
    suppressedIdsByGeneration.set(generation, suppressed);
  }
  suppressed.add(key);
}

function armReplayInitTimer() {
  replayInitTimer = setTimeout(() => {
    clearReplayInitTimer();
    log(`initialize replay timed out after ${GLOBAL_TIMEOUT_MS}ms`);
    requestRestart(`initialize replay timed out after ${GLOBAL_TIMEOUT_MS}ms`);
  }, GLOBAL_TIMEOUT_MS);

  if (typeof replayInitTimer.unref === 'function') {
    replayInitTimer.unref();
  }
}

function clearReplayInitTimer() {
  if (replayInitTimer) {
    clearTimeout(replayInitTimer);
    replayInitTimer = null;
  }
}

function requestTimeoutFor(json) {
  if (json?.method !== 'tools/call') {
    return GLOBAL_TIMEOUT_MS;
  }

  const toolName = safeString(json?.params?.name);
  const args = getToolArguments(json);
  const requestedTimeoutMs = readPositiveIntValue(args?.timeout);
  if (toolName && toolName.endsWith('get_network_request')) {
    return GET_NETWORK_REQUEST_TIMEOUT_MS;
  }

  if (toolName === 'new_page' || toolName === 'navigate_page') {
    return timeoutWithSlack(NAVIGATION_TIMEOUT_MS, requestedTimeoutMs);
  }

  if (toolName === 'wait_for') {
    return timeoutWithSlack(WAIT_FOR_TIMEOUT_MS, requestedTimeoutMs);
  }

  if (isInputTool(toolName)) {
    return timeoutWithSlack(INPUT_TIMEOUT_MS, requestedTimeoutMs);
  }

  if (toolName === 'take_snapshot') {
    return timeoutWithSlack(SNAPSHOT_TIMEOUT_MS, requestedTimeoutMs);
  }

  return timeoutWithSlack(TOOLS_CALL_TIMEOUT_MS, requestedTimeoutMs);
}

async function maybeRecoverTimedOutRequest(item) {
  if (
    item.method !== 'tools/call' ||
    item.dialogRecoveryAttempted === true ||
    DIALOG_RECOVERY_GRACE_MS <= 0
  ) {
    return false;
  }

  const candidatePageIds = candidatePageIdsForDialogRecovery(item);
  if (candidatePageIds.length === 0) {
    return false;
  }

  item.dialogRecoveryAttempted = true;

  const recovery = await tryRecoverBlockingDialog(candidatePageIds, item);
  if (!recovery.cleared) {
    return false;
  }

  const current = pendingRequests.get(item.key);
  if (current !== item) {
    return true;
  }

  clearRequestTimer(item);
  item.timeoutMs = DIALOG_RECOVERY_GRACE_MS;
  armRequestTimer(item);

  log(
    `cleared blocking dialog on page ${String(recovery.pageId)} via direct CDP (${recovery.action}) and granted ${DIALOG_RECOVERY_GRACE_MS}ms grace to ${safeString(item.json?.params?.name)}`,
  );

  return true;
}

function writeJsonRpc(stream, payload) {
  stream.write(encodeForHost(payload));
}

function encodeJsonRpc(payload, framing) {
  if (framing === FRAMING_CONTENT_LENGTH) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    return Buffer.concat([header, body]);
  }
  return Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
}

function encodeForHost(payload) {
  return encodeJsonRpc(payload, hostFraming || FRAMING_CONTENT_LENGTH);
}

function encodeForChild(payload, generation = childGeneration) {
  const framing =
    childFramingByGeneration.get(generation) || DEFAULT_CHILD_FRAMING;
  return encodeJsonRpc(payload, framing);
}

function encodeJsonRpcFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

function isRequest(json) {
  return (
    json &&
    typeof json === 'object' &&
    !Array.isArray(json) &&
    Object.prototype.hasOwnProperty.call(json, 'id') &&
    typeof json.method === 'string'
  );
}

function isResponse(json) {
  return (
    json &&
    typeof json === 'object' &&
    !Array.isArray(json) &&
    Object.prototype.hasOwnProperty.call(json, 'id') &&
    typeof json.method !== 'string'
  );
}

function makeIdKey(id) {
  return `${typeof id}:${String(id)}`;
}

function safeString(value) {
  return typeof value === 'string' ? value : '';
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return `[unserializable:${error instanceof Error ? error.message : String(error)}]`;
  }
}

function getToolArguments(json) {
  const args = json?.params?.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return null;
  }
  return args;
}

function normalizeHostRequest(json, order) {
  if (!isRequest(json) || json.method !== 'tools/call') {
    return null;
  }

  const toolName = safeString(json?.params?.name);
  const args = getToolArguments(json);
  if (!args) {
    return null;
  }

  const validationError = validateToolArguments(toolName, args);
  if (validationError) {
    log(
      `rejected invalid ${toolName} arguments locally: ${validationError.message}`,
    );
    return {
      type: 'immediate_response',
      order,
      json: {
        jsonrpc: '2.0',
        id: json.id,
        error: {
          code: -32602,
          message: validationError.message,
          data: {
            method: toolName,
          },
        },
      },
    };
  }

  const normalizedArgs = normalizeToolArguments(toolName, args);
  if (normalizedArgs === args) {
    return null;
  }

  const normalizedJson = {
    ...json,
    params: {
      ...json.params,
      arguments: normalizedArgs,
    },
  };

  log(`normalized ${toolName} arguments before dispatch`);

  return {
    type: 'normalized_request',
    json: normalizedJson,
  };
}

function validateToolArguments(toolName, args) {
  if (
    (toolName === 'select_page' || toolName === 'close_page') &&
    !Object.prototype.hasOwnProperty.call(args, 'pageId') &&
    Object.prototype.hasOwnProperty.call(args, 'index')
  ) {
    return {
      message: `${toolName} requires \`pageId\`, not \`index\`. Call \`list_pages\` and pass the numeric \`pageId\`.`,
    };
  }

  return null;
}

function normalizeToolArguments(toolName, args) {
  let normalized = args;

  const setValue = (key, value) => {
    const current = normalized[key];
    if (Object.is(current, value)) {
      return;
    }
    if (normalized === args) {
      normalized = { ...args };
    }
    normalized[key] = value;
  };

  for (const key of [
    'pageId',
    'reqid',
    'timeout',
    'pageIdx',
    'pageSize',
    'msgid',
    'width',
    'height',
    'x',
    'y',
  ]) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) {
      continue;
    }
    const coerced = coerceIntegerValue(normalized[key]);
    if (coerced !== undefined) {
      setValue(key, coerced);
    }
  }

  for (const key of [
    'background',
    'bringToFront',
    'verbose',
    'ignoreCache',
    'includePreservedRequests',
    'includePreservedMessages',
    'includeSnapshot',
    'dblClick',
  ]) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) {
      continue;
    }
    const coerced = coerceBooleanValue(normalized[key]);
    if (coerced !== undefined) {
      setValue(key, coerced);
    }
  }

  if (toolName === 'wait_for' && typeof normalized.text === 'string') {
    setValue('text', [normalized.text]);
  }

  if (toolName === 'evaluate_script' && typeof normalized.args === 'string') {
    setValue('args', [normalized.args]);
  }

  return normalized;
}

function coerceIntegerValue(value) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  if (!/^-?\d+$/.test(value.trim())) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function coerceBooleanValue(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  return undefined;
}

function isInputTool(toolName) {
  return [
    'click',
    'click_at',
    'hover',
    'fill',
    'fill_form',
    'drag',
    'upload_file',
    'type_text',
    'press_key',
  ].includes(toolName);
}

function readPositiveIntValue(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function timeoutWithSlack(baseTimeoutMs, requestedTimeoutMs) {
  if (!requestedTimeoutMs) {
    return baseTimeoutMs;
  }
  return Math.max(baseTimeoutMs, requestedTimeoutMs + REQUEST_TIMEOUT_SLACK_MS);
}

function augmentToolResponse(pending, json) {
  if (!pending || pending.method !== 'tools/call') {
    return json;
  }

  const errorMessage = safeString(json?.error?.message);
  if (!errorMessage) {
    return json;
  }

  const toolName = safeString(pending.json?.params?.name);
  const hint = buildRecoveryHint(toolName, errorMessage);
  if (!hint || errorMessage.includes(hint)) {
    return json;
  }

  return {
    ...json,
    error: {
      ...json.error,
      message: `${errorMessage} Recovery: ${hint}`,
      data: {
        ...(json.error?.data && typeof json.error.data === 'object'
          ? json.error.data
          : {}),
        tool_name: toolName || null,
        recovery_hint: hint,
      },
    },
  };
}

function buildRecoveryHint(toolName, errorMessage) {
  const lowered = errorMessage.toLowerCase();

  if (
    (toolName === 'select_page' || toolName === 'close_page') &&
    lowered.includes('pageid')
  ) {
    return 'Call `list_pages` first and pass the numeric `pageId`. Do not use `index`.';
  }

  if (toolName === 'wait_for' && lowered.includes('text')) {
    return 'Use `text` as a non-empty string array, for example `{\"text\":[\"Password\"],\"timeout\":15000}`.';
  }

  if (lowered.includes('no snapshot found')) {
    return 'Call `take_snapshot` on the target page, then retry using a UID from the latest snapshot.';
  }

  if (
    lowered.includes('uid') &&
    (lowered.includes('not found') ||
      lowered.includes('stale') ||
      lowered.includes('resolve') ||
      lowered.includes('backend node'))
  ) {
    return 'Take a fresh snapshot and retry with a UID from that snapshot. Do not reuse UIDs after DOM rewrites, navigation, or page switches.';
  }

  if (
    lowered.includes('no page found') ||
    lowered.includes('call select_page first') ||
    lowered.includes('target page holds browser focus') ||
    lowered.includes('selected page')
  ) {
    return 'Call `list_pages`, choose the correct `pageId`, then run `select_page` before retrying.';
  }

  if (
    (toolName === 'new_page' || toolName === 'navigate_page') &&
    lowered.includes('timeout')
  ) {
    return 'Retry with an explicit numeric `timeout` in milliseconds if the page is legitimately slow.';
  }

  if (toolName === 'get_network_request' && lowered.includes('timeout')) {
    return 'Use `list_network_requests` first, then inspect a single completed `reqid` with `get_network_request`.';
  }

  return null;
}

function readCliFlagValue(args, flagName) {
  const directPrefix = `${flagName}=`;
  for (let index = 0; index < args.length; index += 1) {
    const current = safeString(args[index]);
    if (current.startsWith(directPrefix)) {
      return current.slice(directPrefix.length);
    }
    if (current === flagName && index + 1 < args.length) {
      return safeString(args[index + 1]);
    }
  }
  return '';
}

function normalizeBrowserVersionUrl(rawUrl) {
  if (!rawUrl) {
    return '';
  }

  try {
    const parsed = new URL(rawUrl);
    if (parsed.pathname === '/json' || parsed.pathname === '/json/') {
      parsed.pathname = '/json/version';
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

function deriveBrowserListUrl(versionUrl) {
  if (!versionUrl) {
    return '';
  }

  try {
    const parsed = new URL(versionUrl);
    parsed.pathname = '/json/list';
    parsed.search = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

async function primeBrowserTargetSnapshot() {
  const snapshot = await fetchBrowserPageTargets();
  if (!snapshot) {
    return;
  }

  reconcileBrowserTargetSnapshot(snapshot);
  log(`primed browser target snapshot with ${snapshot.targets.length} page targets`);
}

async function fetchBrowserPageTargets() {
  if (!BROWSER_VERSION_URL || !BROWSER_LIST_URL) {
    return null;
  }

  try {
    const [versionInfo, targetList] = await Promise.all([
      fetchJson(BROWSER_VERSION_URL, BROWSER_TARGET_FETCH_TIMEOUT_MS),
      fetchJson(BROWSER_LIST_URL, BROWSER_TARGET_FETCH_TIMEOUT_MS),
    ]);

    const browserWsUrl = safeString(versionInfo?.webSocketDebuggerUrl);
    if (!Array.isArray(targetList)) {
      return {
        browserWsUrl,
        targets: [],
      };
    }

    return {
      browserWsUrl,
      targets: targetList
        .map((target) => {
          const targetId = safeString(target?.id);
          const type = safeString(target?.type);
          const url = safeString(target?.url);
          const webSocketDebuggerUrl = safeString(target?.webSocketDebuggerUrl);
          if (!targetId || type !== 'page' || !webSocketDebuggerUrl) {
            return null;
          }
          return {
            targetId,
            url,
            webSocketDebuggerUrl,
          };
        })
        .filter(Boolean),
    };
  } catch (error) {
    log(`browser target fetch failed: ${error.message}`);
    return null;
  }
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  try {
    const response = await fetch(url, {
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function reconcileBrowserTargetSnapshot(snapshot) {
  const previousIds = new Set(knownTargetIds);

  if (snapshot.browserWsUrl && snapshot.browserWsUrl !== knownBrowserWsUrl) {
    knownBrowserWsUrl = snapshot.browserWsUrl;
    knownTargetIds = new Set();
    clearAllPageTargets();
  } else if (snapshot.browserWsUrl) {
    knownBrowserWsUrl = snapshot.browserWsUrl;
  }

  knownTargetIds = new Set(snapshot.targets.map((target) => target.targetId));
  reconcileExistingPageTargets(snapshot.targets);
  return previousIds;
}

function clearAllPageTargets() {
  for (const pageId of pageTargets.keys()) {
    releasePageTarget(pageId);
  }
}

function reconcileExistingPageTargets(targets) {
  const liveTargets = new Map(targets.map((target) => [target.targetId, target]));
  for (const [pageId, mapping] of pageTargets.entries()) {
    const target = liveTargets.get(mapping.targetId);
    if (!target) {
      releasePageTarget(pageId);
      continue;
    }
    setPageTarget(pageId, target);
  }
}

function setPageTarget(pageId, target) {
  const existing = pageTargets.get(pageId);
  if (existing?.targetId && existing.targetId !== target.targetId) {
    targetPages.delete(existing.targetId);
  }

  const previousPageId = targetPages.get(target.targetId);
  if (previousPageId != null && previousPageId !== pageId) {
    pageTargets.delete(previousPageId);
  }

  pageTargets.set(pageId, target);
  targetPages.set(target.targetId, pageId);
}

function releasePageTarget(pageId) {
  const existing = pageTargets.get(pageId);
  if (!existing) {
    return;
  }
  targetPages.delete(existing.targetId);
  pageTargets.delete(pageId);
}

async function reconcilePageTargetsForResponse({ ownerKey, toolName, args, pages }) {
  if (!Array.isArray(pages) || pages.length === 0) {
    return;
  }

  const snapshot = await fetchBrowserPageTargets();
  if (!snapshot) {
    return;
  }

  const previousIds = reconcileBrowserTargetSnapshot(snapshot);
  assignTargetsByUniqueUrl(pages, snapshot.targets);

  if (toolName !== 'new_page') {
    return;
  }

  const ownerState = ownerKey ? getOwnerState(ownerKey) : null;
  const candidatePageId =
    ownerState?.selectedPageId ??
    pages.find((page) => page.selected)?.id ??
    pages[pages.length - 1]?.id ??
    null;
  if (candidatePageId == null || pageTargets.has(candidatePageId)) {
    return;
  }

  const preferredUrls = [
    safeString(args?.url),
    safeString(pageMetadata.get(candidatePageId)?.url),
  ].filter(Boolean);

  const availableNewTargets = snapshot.targets.filter(
    (target) =>
      !previousIds.has(target.targetId) && !targetPages.has(target.targetId),
  );

  const availableTargets = snapshot.targets.filter(
    (target) => !targetPages.has(target.targetId),
  );

  const candidate =
    chooseUniqueTargetByPreferredUrl(availableNewTargets, preferredUrls) ??
    (availableNewTargets.length === 1 ? availableNewTargets[0] : null) ??
    chooseUniqueTargetByPreferredUrl(availableTargets, preferredUrls) ??
    null;

  if (!candidate) {
    return;
  }

  setPageTarget(candidatePageId, candidate);
  log(
    `mapped page ${String(candidatePageId)} to target ${candidate.targetId} (${candidate.url || 'about:blank'})`,
  );
}

function assignTargetsByUniqueUrl(pages, targets) {
  const availableTargets = targets.filter((target) => !targetPages.has(target.targetId));
  const targetsByUrl = new Map();

  for (const target of availableTargets) {
    const key = normalizeUrlForMatch(target.url);
    if (!key) {
      continue;
    }
    const bucket = targetsByUrl.get(key) ?? [];
    bucket.push(target);
    targetsByUrl.set(key, bucket);
  }

  for (const page of pages) {
    if (pageTargets.has(page.id)) {
      continue;
    }
    const key = normalizeUrlForMatch(page.url);
    if (!key) {
      continue;
    }
    const matches = targetsByUrl.get(key);
    if (!matches || matches.length !== 1) {
      continue;
    }
    const [target] = matches;
    setPageTarget(page.id, target);
    targetsByUrl.delete(key);
    log(`mapped page ${String(page.id)} to target ${target.targetId} by unique URL`);
  }
}

function chooseUniqueTargetByPreferredUrl(targets, preferredUrls) {
  for (const preferredUrl of preferredUrls) {
    const normalizedPreferredUrl = normalizeUrlForMatch(preferredUrl);
    if (!normalizedPreferredUrl) {
      continue;
    }
    const matches = targets.filter(
      (target) => normalizeUrlForMatch(target.url) === normalizedPreferredUrl,
    );
    if (matches.length === 1) {
      return matches[0];
    }
  }
  return null;
}

function normalizeUrlForMatch(rawUrl) {
  const text = safeString(rawUrl).trim();
  if (!text) {
    return '';
  }

  try {
    const parsed = new URL(text);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return text;
  }
}

function recordPotentialDialogRisk(item) {
  if (item.method !== 'tools/call') {
    return;
  }

  const toolName = safeString(item.json?.params?.name);
  if (!isDialogRiskTool(toolName)) {
    return;
  }

  const args = getToolArguments(item.json);
  const pageId =
    item.callContext?.effectivePageId ?? readPositiveIntValue(args?.pageId);
  if (pageId == null) {
    return;
  }

  const strings = collectStringLeaves(args);
  let score = isInteractiveTool(toolName) ? 1 : 0;
  let preferredAction = 'dismiss';

  if (strings.some((value) => /alert\s*\(/i.test(value))) {
    score = Math.max(score, 4);
    preferredAction = 'accept';
  } else if (
    strings.some((value) => /<script|onerror\s*=|onload\s*=|javascript:/i.test(value))
  ) {
    score = Math.max(score, 3);
  } else if (toolName === 'evaluate_script') {
    score = Math.max(score, 2);
  }

  if (score <= 0) {
    return;
  }

  dialogRiskByPage.set(pageId, {
    at: Date.now(),
    ownerKey: item.callContext?.ownerKey ?? '',
    preferredAction,
    score,
    toolName,
  });
}

function collectStringLeaves(value, bucket = []) {
  if (typeof value === 'string') {
    bucket.push(value);
    return bucket;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStringLeaves(entry, bucket);
    }
    return bucket;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      collectStringLeaves(entry, bucket);
    }
  }
  return bucket;
}

function isDialogRiskTool(toolName) {
  return [
    'click',
    'click_at',
    'fill',
    'fill_form',
    'type_text',
    'press_key',
    'evaluate_script',
    'navigate_page',
  ].includes(toolName);
}

function isInteractiveTool(toolName) {
  return [
    'click',
    'click_at',
    'fill',
    'fill_form',
    'type_text',
    'press_key',
    'navigate_page',
  ].includes(toolName);
}

function candidatePageIdsForDialogRecovery(item) {
  const candidateIds = [];
  const explicitPageId =
    item.callContext?.effectivePageId ??
    readPositiveIntValue(getToolArguments(item.json)?.pageId);

  if (explicitPageId != null) {
    candidateIds.push(explicitPageId);
  }

  const cutoff = Date.now() - DIALOG_RISK_WINDOW_MS;
  const recentRiskPages = [...dialogRiskByPage.entries()]
    .filter(([, risk]) => risk.at >= cutoff)
    .sort((left, right) => {
      const scoreDelta = right[1].score - left[1].score;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return right[1].at - left[1].at;
    })
    .map(([pageId]) => pageId);

  for (const pageId of recentRiskPages) {
    if (!candidateIds.includes(pageId)) {
      candidateIds.push(pageId);
    }
  }

  return candidateIds.slice(0, 5);
}

async function tryRecoverBlockingDialog(pageIds, item) {
  for (const pageId of pageIds) {
    const target = await resolvePageTarget(pageId);
    if (!target?.targetId) {
      continue;
    }

    const accept = shouldAcceptRecoveredDialog(pageId, item);
    const outcome = await handleDialogViaTarget(target, accept);

    if (!outcome.cleared) {
      log(
        `dialog recovery attempt on page ${String(pageId)} target ${target.targetId} failed: ${outcome.reason || 'unknown'}`,
      );
      continue;
    }

    dialogRiskByPage.delete(pageId);
    return {
      cleared: true,
      pageId,
      action: accept ? 'accept' : 'dismiss',
      targetId: target.targetId,
    };
  }

  return { cleared: false };
}

async function resolvePageTarget(pageId) {
  const current = pageTargets.get(pageId);
  if (current) {
    return current;
  }

  const metadata = pageMetadata.get(pageId);
  if (!metadata) {
    return null;
  }

  await reconcilePageTargetsForResponse({
    ownerKey: pageOwners.get(pageId) ?? '',
    toolName: 'list_pages',
    args: {},
    pages: [
      {
        id: pageId,
        url: metadata.url,
        selected: false,
        isolatedContext: metadata.isolatedContext,
      },
    ],
  });

  return pageTargets.get(pageId) ?? null;
}

async function trackPageStateFromResponse(pending, json) {
  if (!pending || pending.method !== 'tools/call') {
    return;
  }

  const toolName = safeString(pending.json?.params?.name);
  const args = getToolArguments(pending.json) || {};
  const effectivePageId =
    pending.callContext?.effectivePageId ?? readPositiveIntValue(args.pageId);

  if (!json?.error && toolName === 'close_page' && effectivePageId != null) {
    releasePageTarget(effectivePageId);
    dialogRiskByPage.delete(effectivePageId);
  }

  if (!json?.error && toolName === 'handle_dialog' && effectivePageId != null) {
    dialogRiskByPage.delete(effectivePageId);
  }

  const structuredPages = getStructuredPages(json);
  if (!structuredPages) {
    return;
  }

  updatePageMetadata(structuredPages);
  await reconcilePageTargetsForResponse({
    ownerKey: pending.callContext?.ownerKey ?? '',
    toolName,
    args,
    pages: structuredPages,
  });
}

async function maybeRecoverAfterChildError(pending, json) {
  if (!pending || pending.method !== 'tools/call') {
    return;
  }

  if (pending.childErrorRecoveryAttempted === true) {
    return;
  }

  const errorMessage = safeString(json?.error?.message);
  if (!isRecoverableDialogProtocolError(errorMessage)) {
    return;
  }

  const candidatePageIds = candidatePageIdsForDialogRecovery(pending);
  if (candidatePageIds.length === 0) {
    return;
  }

  pending.childErrorRecoveryAttempted = true;
  const recovery = await tryRecoverBlockingDialog(candidatePageIds, pending);
  if (!recovery.cleared) {
    return;
  }

  log(
    `cleared blocking dialog on page ${String(recovery.pageId)} after upstream ${safeString(
      pending.json?.params?.name,
    )} error: ${errorMessage}`,
  );
}

function isRecoverableDialogProtocolError(errorMessage) {
  const lowered = safeString(errorMessage).toLowerCase();
  if (!lowered.includes('timed out')) {
    return false;
  }

  return (
    lowered.includes('protocolerror') ||
    lowered.includes('runtime.callfunctionon') ||
    lowered.includes('network.enable')
  );
}

function shouldAcceptRecoveredDialog(pageId, item) {
  const toolName = safeString(item.json?.params?.name);
  if (toolName === 'handle_dialog') {
    const requestedAction = safeString(getToolArguments(item.json)?.action);
    return requestedAction !== 'dismiss';
  }

  const risk = dialogRiskByPage.get(pageId);
  return risk?.preferredAction === 'accept';
}

async function handleDialogViaTarget(target, accept) {
  const viaBrowserTarget = await handleDialogViaBrowserTarget(target.targetId, accept);
  if (viaBrowserTarget.cleared) {
    return viaBrowserTarget;
  }

  if (!target.webSocketDebuggerUrl) {
    return viaBrowserTarget;
  }

  const viaPageTarget = await handleDialogViaPageWebSocket(
    target.webSocketDebuggerUrl,
    accept,
  );

  if (viaPageTarget.cleared) {
    return viaPageTarget;
  }

  return {
    cleared: false,
    reason: viaPageTarget.reason || viaBrowserTarget.reason || 'unknown',
  };
}

async function handleDialogViaBrowserTarget(targetId, accept) {
  if (!knownBrowserWsUrl) {
    return {
      cleared: false,
      reason: 'no_browser_ws',
    };
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeout = null;
    let nextId = 1;
    let sessionId = null;
    const pending = new Map();
    const ws = new WebSocket(knownBrowserWsUrl);

    const finish = async (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }

      if (sessionId) {
        try {
          ws.send(
            JSON.stringify({
              id: nextId++,
              method: 'Target.detachFromTarget',
              params: { sessionId },
            }),
          );
        } catch {}
      }

      try {
        ws.close();
      } catch {}
      resolve(result);
    };

    const send = (method, params, attachedSessionId) =>
      new Promise((resolveMessage) => {
        const id = nextId++;
        pending.set(id, resolveMessage);
        const payload = {
          id,
          method,
          params,
          ...(attachedSessionId ? { sessionId: attachedSessionId } : {}),
        };
        ws.send(JSON.stringify(payload));
      });

    timeout = setTimeout(() => {
      void finish({ cleared: false, reason: 'timeout' });
    }, BROWSER_TARGET_FETCH_TIMEOUT_MS);

    if (typeof timeout.unref === 'function') {
      timeout.unref();
    }

    ws.on('open', async () => {
      try {
        const attachMessage = await send('Target.attachToTarget', {
          targetId,
          flatten: true,
        });
        sessionId = safeString(attachMessage?.result?.sessionId);
        if (!sessionId) {
          await finish({ cleared: false, reason: 'attach_failed' });
          return;
        }

        const handleMessage = await send(
          'Page.handleJavaScriptDialog',
          { accept },
          sessionId,
        );

        if (handleMessage?.error) {
          await finish({
            cleared: false,
            reason: safeString(handleMessage.error?.message) || 'cdp_error',
          });
          return;
        }

        await finish({ cleared: true });
      } catch (error) {
        await finish({ cleared: false, reason: error.message });
      }
    });

    ws.on('message', (payload) => {
      let message;
      try {
        message = JSON.parse(String(payload));
      } catch {
        return;
      }

      if (message.id != null && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });

    ws.on('error', (error) => {
      void finish({ cleared: false, reason: error.message });
    });

    ws.on('close', () => {
      void finish({ cleared: false, reason: 'closed' });
    });
  });
}

async function handleDialogViaPageWebSocket(webSocketUrl, accept) {
  return new Promise((resolve) => {
    let settled = false;
    let timeout = null;
    const ws = new WebSocket(webSocketUrl);

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      try {
        ws.close();
      } catch {}
      resolve(result);
    };

    timeout = setTimeout(() => {
      finish({ cleared: false, reason: 'timeout' });
    }, BROWSER_TARGET_FETCH_TIMEOUT_MS);

    if (typeof timeout.unref === 'function') {
      timeout.unref();
    }

    ws.on('open', () => {
      try {
        ws.send(
          JSON.stringify({
            id: 1,
            method: 'Page.handleJavaScriptDialog',
            params: {
              accept,
            },
          }),
        );
      } catch (error) {
        finish({ cleared: false, reason: error.message });
      }
    });

    ws.on('message', (payload) => {
      let message;
      try {
        message = JSON.parse(String(payload));
      } catch {
        return;
      }

      if (message.id !== 1) {
        return;
      }

      if (message.error) {
        finish({
          cleared: false,
          reason: safeString(message.error?.message) || 'cdp_error',
        });
        return;
      }

      finish({ cleared: true });
    });

    ws.on('error', (error) => {
      finish({ cleared: false, reason: error.message });
    });

    ws.on('close', () => {
      finish({ cleared: false, reason: 'closed' });
    });
  });
}

function readIntEnv(names, fallback) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw == null || raw === '') {
      continue;
    }
    const value = Number.parseInt(raw, 10);
    if (Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return fallback;
}

function findHeaderMarker(buffer) {
  const crlfIndex = buffer.indexOf('\r\n\r\n');
  if (crlfIndex !== -1) {
    return { index: crlfIndex, length: 4 };
  }

  const lfIndex = buffer.indexOf('\n\n');
  if (lfIndex !== -1) {
    return { index: lfIndex, length: 2 };
  }

  return null;
}

function stripTrailingCarriageReturn(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function log(message) {
  const line = `[${new Date().toISOString()}] [browser-live-mcp-proxy] ${message}\n`;
  if (PROXY_LOG_FILE) {
    try {
      fs.appendFileSync(PROXY_LOG_FILE, line, 'utf8');
      return;
    } catch {
      // Fall back to stderr.
    }
  }
  process.stderr.write(line);
}

function shutdown() {
  if (stopRequested) {
    return;
  }

  stopRequested = true;
  clearTimeout(startTimer);
  clearReplayInitTimer();

  if (child && child.exitCode === null && !child.killed) {
    try {
      child.kill('SIGTERM');
    } catch {
      // Ignore shutdown races.
    }
  }

  process.exit(0);
}
