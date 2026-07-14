#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

function parseTimeout(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const GET_NETWORK_REQUEST_TIMEOUT_MS = parseTimeout(
  'BROWSER_LIVE_GET_NETWORK_REQUEST_TIMEOUT_MS',
  15000,
);
const PROTOCOL_TIMEOUT_MS = parseTimeout(
  'BROWSER_LIVE_PROTOCOL_TIMEOUT_MS',
  60000,
);
const DEFAULT_ACTION_TIMEOUT_MS = parseTimeout(
  'BROWSER_LIVE_DEFAULT_ACTION_TIMEOUT_MS',
  10000,
);
const DEFAULT_NAVIGATION_TIMEOUT_MS = parseTimeout(
  'BROWSER_LIVE_DEFAULT_NAVIGATION_TIMEOUT_MS',
  20000,
);
const PATCH_LOG_FILE = process.env.BROWSER_LIVE_MCP_PATCH_LOG_FILE;
let stdinKeepaliveTimer = null;

function log(message) {
  const line = `${new Date().toISOString()} browser-live-mcp-guard: ${message}\n`;
  try {
    if (PATCH_LOG_FILE) {
      fs.appendFileSync(PATCH_LOG_FILE, line, 'utf8');
      return;
    }
  } catch {
    // Fall back to stderr.
  }
  try {
    process.stderr.write(line);
  } catch {
    // Ignore logging failures.
  }
}

function formatError(error) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

function describeRequest(request) {
  try {
    return `${request.method()} ${request.url()}`;
  } catch {
    return '<unknown request>';
  }
}

function installStdinKeepalive() {
  if (stdinKeepaliveTimer) {
    return;
  }

  // The upstream stdio server can exit cleanly before the first request if the
  // client is slightly slower to send initialize than process startup. Keep one
  // timer referenced for the lifetime of the stdio pipe and release it once the
  // client closes stdin.
  stdinKeepaliveTimer = setInterval(() => {}, 1 << 30);

  const release = () => {
    if (!stdinKeepaliveTimer) {
      return;
    }
    clearInterval(stdinKeepaliveTimer);
    stdinKeepaliveTimer = null;
    process.stdin.off('end', release);
    process.stdin.off('close', release);
  };

  process.stdin.on('end', release);
  process.stdin.on('close', release);
  process.once('exit', release);
}

function getNetworkMultiplier(networkCondition) {
  switch (networkCondition) {
    case 'Slow 4G':
      return 2.5;
    case 'Fast 3G':
      return 5;
    case 'Slow 3G':
      return 10;
    default:
      return 1;
  }
}

function applyPageTimeouts(mcpPage) {
  const page = mcpPage?.pptrPage;
  if (!page) {
    return;
  }

  const cpuMultiplier =
    Number.isFinite(mcpPage.cpuThrottlingRate) && mcpPage.cpuThrottlingRate > 0
      ? mcpPage.cpuThrottlingRate
      : 1;
  const networkMultiplier = getNetworkMultiplier(mcpPage.networkConditions);

  if (DEFAULT_ACTION_TIMEOUT_MS > 0) {
    page.setDefaultTimeout(DEFAULT_ACTION_TIMEOUT_MS * cpuMultiplier);
  }
  if (DEFAULT_NAVIGATION_TIMEOUT_MS > 0) {
    page.setDefaultNavigationTimeout(
      DEFAULT_NAVIGATION_TIMEOUT_MS * networkMultiplier,
    );
  }
}

function resolveChromeDevtoolsMcpRoot() {
  const override = process.env.BROWSER_LIVE_CHROME_DEVTOOLS_MCP_ROOT;
  if (override) {
    const packageJson = path.join(override, 'package.json');
    if (fs.existsSync(packageJson)) {
      return override;
    }
    throw new Error(
      `BROWSER_LIVE_CHROME_DEVTOOLS_MCP_ROOT does not contain package.json: ${override}`,
    );
  }

  const npxRoot = path.join(os.homedir(), '.npm', '_npx');
  const candidates = [];
  if (fs.existsSync(npxRoot)) {
    for (const entry of fs.readdirSync(npxRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageJson = path.join(
        npxRoot,
        entry.name,
        'node_modules',
        'chrome-devtools-mcp',
        'package.json',
      );
      if (!fs.existsSync(packageJson)) {
        continue;
      }
      const stat = fs.statSync(packageJson);
      candidates.push({
        root: path.dirname(packageJson),
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  candidates.sort((left, right) => {
    if (right.mtimeMs !== left.mtimeMs) {
      return right.mtimeMs - left.mtimeMs;
    }
    return left.root.localeCompare(right.root);
  });

  if (candidates.length > 0) {
    return candidates[0].root;
  }

  throw new Error(
    'chrome-devtools-mcp was not found under ~/.npm/_npx. Prime the cache once or set BROWSER_LIVE_CHROME_DEVTOOLS_MCP_ROOT.',
  );
}

function packageModuleUrl(packageRoot, relativePath) {
  return pathToFileURL(path.join(packageRoot, relativePath)).href;
}

function annotateTimedOutFormatter(formatter, request, timeoutMs) {
  const warning =
    `Detailed body fetch timed out after ${timeoutMs} ms; returning request metadata without bodies.`;
  const originalToJSONDetailed = formatter.toJSONDetailed.bind(formatter);
  const originalToStringDetailed = formatter.toStringDetailed.bind(formatter);

  formatter.toJSONDetailed = () => {
    const detailed = originalToJSONDetailed();
    const annotated = {
      ...detailed,
      bodyFetchWarning: warning,
    };
    try {
      if (annotated.requestBody === undefined && request.hasPostData()) {
        annotated.requestBody = `<${warning}>`;
      }
    } catch {
      // Ignore request body detection failures.
    }
    try {
      if (annotated.responseBody === undefined && request.response()) {
        annotated.responseBody = `<${warning}>`;
      }
    } catch {
      // Ignore response body detection failures.
    }
    return annotated;
  };

  formatter.toStringDetailed = () => {
    const rendered = originalToStringDetailed();
    return `${rendered}\n### Body Fetch\n${warning}`;
  };

  return formatter;
}

async function installNetworkFormatterGuard(packageRoot) {
  const formatterUrl = pathToFileURL(
    path.join(packageRoot, 'build/src/formatters/NetworkFormatter.js'),
  ).href;
  const { NetworkFormatter } = await import(formatterUrl);

  if (NetworkFormatter.__browserLiveGuardInstalled) {
    return;
  }

  const originalFrom = NetworkFormatter.from.bind(NetworkFormatter);

  NetworkFormatter.from = async function guardedNetworkFormatterFrom(request, options) {
    if (!options?.fetchData || GET_NETWORK_REQUEST_TIMEOUT_MS <= 0) {
      return originalFrom(request, options);
    }

    const timeoutSentinel = Symbol('get-network-request-timeout');
    let timer;

    const originalPromise = Promise.resolve().then(() => originalFrom(request, options));
    let racedResult;
    try {
      racedResult = await Promise.race([
        originalPromise,
        new Promise(resolve => {
          timer = setTimeout(() => resolve(timeoutSentinel), GET_NETWORK_REQUEST_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }

    if (racedResult !== timeoutSentinel) {
      return racedResult;
    }

    log(
      `get_network_request timed out after ${GET_NETWORK_REQUEST_TIMEOUT_MS} ms for ${describeRequest(request)}`,
    );

    originalPromise.catch(error => {
      log(`ignored post-timeout completion failure for ${describeRequest(request)}: ${formatError(error)}`);
    });

    const fallback = await originalFrom(request, {
      ...options,
      fetchData: false,
    });
    return annotateTimedOutFormatter(fallback, request, GET_NETWORK_REQUEST_TIMEOUT_MS);
  };

  Object.defineProperty(NetworkFormatter, '__browserLiveGuardInstalled', {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
}

async function installPuppeteerProtocolGuard(packageRoot) {
  if (PROTOCOL_TIMEOUT_MS <= 0) {
    return;
  }

  const thirdPartyUrl = pathToFileURL(
    path.join(packageRoot, 'build/src/third_party/index.js'),
  ).href;
  const thirdParty = await import(thirdPartyUrl);
  const { puppeteer } = thirdParty;

  if (puppeteer.__browserLiveProtocolGuardInstalled) {
    return;
  }

  const originalConnect = puppeteer.connect.bind(puppeteer);
  const originalLaunch = puppeteer.launch.bind(puppeteer);

  puppeteer.connect = options => {
    return originalConnect({
      ...options,
      protocolTimeout: options?.protocolTimeout ?? PROTOCOL_TIMEOUT_MS,
    });
  };

  puppeteer.launch = options => {
    return originalLaunch({
      ...options,
      protocolTimeout: options?.protocolTimeout ?? PROTOCOL_TIMEOUT_MS,
    });
  };

  Object.defineProperty(puppeteer, '__browserLiveProtocolGuardInstalled', {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
}

async function installMcpContextTimeoutGuard(packageRoot) {
  const mcpContextUrl = pathToFileURL(
    path.join(packageRoot, 'build/src/McpContext.js'),
  ).href;
  const { McpContext } = await import(mcpContextUrl);

  if (McpContext.__browserLiveTimeoutGuardInstalled) {
    return;
  }

  const originalSelectPage = McpContext.prototype.selectPage;

  McpContext.prototype.selectPage = function guardedSelectPage(newPage) {
    const result = originalSelectPage.call(this, newPage);
    try {
      applyPageTimeouts(newPage);
    } catch (error) {
      log(`failed to apply patched page timeouts: ${formatError(error)}`);
    }
    return result;
  };

  Object.defineProperty(McpContext, '__browserLiveTimeoutGuardInstalled', {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
}

class BrowserLiveStdioTransport {
  constructor(stdin = process.stdin, stdout = process.stdout) {
    this.stdin = stdin;
    this.stdout = stdout;
    this.buffer = Buffer.alloc(0);
    this.started = false;
    this.closed = false;
    this.onmessage = undefined;
    this.onerror = undefined;
    this.onclose = undefined;
    this.onData = chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.processBuffer();
    };
    this.onInputError = error => {
      this.onerror?.(error);
    };
    this.onInputEnd = () => {
      this.closeTransport();
    };
  }

  async start() {
    if (this.started) {
      throw new Error('BrowserLiveStdioTransport already started');
    }
    this.started = true;
    this.stdin.on('data', this.onData);
    this.stdin.on('error', this.onInputError);
    this.stdin.on('end', this.onInputEnd);
    this.stdin.on('close', this.onInputEnd);
    this.stdin.resume();
  }

  processBuffer() {
    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }

      const line = this.buffer
        .subarray(0, newlineIndex)
        .toString('utf8')
        .replace(/\r$/, '');
      this.buffer = this.buffer.subarray(newlineIndex + 1);

      if (!line.trim()) {
        continue;
      }

      try {
        this.onmessage?.(JSON.parse(line));
      } catch (error) {
        this.onerror?.(error);
      }
    }
  }

  async close() {
    this.closeTransport();
  }

  closeTransport() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stdin.off('data', this.onData);
    this.stdin.off('error', this.onInputError);
    this.stdin.off('end', this.onInputEnd);
    this.stdin.off('close', this.onInputEnd);
    this.buffer = Buffer.alloc(0);
    this.onclose?.();
  }

  send(message) {
    const payload = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
    return new Promise(resolve => {
      if (this.stdout.write(payload)) {
        resolve();
      } else {
        this.stdout.once('drain', resolve);
      }
    });
  }
}

async function main() {
  installStdinKeepalive();

  const packageRoot = resolveChromeDevtoolsMcpRoot();
  await installPuppeteerProtocolGuard(packageRoot);
  await installMcpContextTimeoutGuard(packageRoot);
  await installNetworkFormatterGuard(packageRoot);
  log(
    `loaded chrome-devtools-mcp guard from ${packageRoot} with get_network_request timeout ${GET_NETWORK_REQUEST_TIMEOUT_MS} ms, protocol timeout ${PROTOCOL_TIMEOUT_MS} ms, action timeout ${DEFAULT_ACTION_TIMEOUT_MS} ms, navigation timeout ${DEFAULT_NAVIGATION_TIMEOUT_MS} ms`,
  );
  await import(packageModuleUrl(packageRoot, 'build/src/polyfill.js'));

  const [
    { createMcpServer },
    { logger, saveLogsToFile },
    { computeFlagUsage },
    { VERSION },
    cliModule,
  ] = await Promise.all([
    import(packageModuleUrl(packageRoot, 'build/src/index.js')),
    import(packageModuleUrl(packageRoot, 'build/src/logger.js')),
    import(packageModuleUrl(packageRoot, 'build/src/telemetry/flagUtils.js')),
    import(packageModuleUrl(packageRoot, 'build/src/version.js')),
    import(
      packageModuleUrl(
        packageRoot,
        'build/src/bin/chrome-devtools-mcp-cli-options.js',
      )
    ),
  ]);

  const { cliOptions, parseArguments } = cliModule;
  const args = parseArguments(VERSION);
  const logFile = args.logFile ? saveLogsToFile(args.logFile) : undefined;

  if (process.env.CI || process.env.CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS) {
    logger(
      "turning off usage statistics. process.env['CI'] || process.env['CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS'] is set.",
    );
    args.usageStatistics = false;
  }

  if (process.env.CHROME_DEVTOOLS_MCP_CRASH_ON_UNCAUGHT !== 'true') {
    process.on('unhandledRejection', (reason, promise) => {
      logger('Unhandled promise rejection', promise, reason);
    });
  }

  logger(`Starting Chrome DevTools MCP Server v${VERSION}`);
  const { server, clearcutLogger } = await createMcpServer(args, { logFile });
  const transport = new BrowserLiveStdioTransport();
  await server.connect(transport);
  logger('Chrome DevTools MCP Server connected');

  void clearcutLogger?.logDailyActiveIfNeeded();
  void clearcutLogger?.logServerStart(computeFlagUsage(args, cliOptions));
}

main().catch(error => {
  log(`fatal startup failure: ${formatError(error)}`);
  process.exitCode = 1;
});
