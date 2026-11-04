#!/usr/bin/env node
/**
 * Persistent Headless Chrome (Puppeteer) JSON-RPC Bridge for OpenJK E2E Tests.
 * Communicates over stdin/stdout using line-delimited JSON prefixed with "__RPC_RES__".
 */

const readline = require("readline");
const puppeteer = require("puppeteer-core");

const RPC_PREFIX = "__RPC_RES__";

let browser = null;
let page = null;
let consoleLogs = [];
let pageErrors = [];
let requestFailures = [];

function attachPageListeners(targetPage) {
  targetPage.on("console", (msg) => {
    const text = msg.text();
    consoleLogs.push({
      type: msg.type(),
      text,
      ts: Date.now(),
    });
    if (consoleLogs.length > 2000) {
      consoleLogs.shift();
    }
  });

  targetPage.on("pageerror", (err) => {
    pageErrors.push({
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : "",
      ts: Date.now(),
    });
  });

  targetPage.on("requestfailed", (req) => {
    requestFailures.push({
      url: req.url(),
      errorText: req.failure() ? req.failure().errorText : "unknown",
      ts: Date.now(),
    });
  });
}

async function ensureBrowser() {
  if (browser && page && !page.isClosed()) {
    return page;
  }
  if (browser) {
    try {
      await browser.close();
    } catch (_) {}
  }
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu-sandbox",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-dev-shm-usage",
    ],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  consoleLogs = [];
  pageErrors = [];
  requestFailures = [];
  attachPageListeners(page);
  return page;
}

async function waitForPlayerReady(targetPage, timeoutMs = 90000, requirePlaying = true) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const status = await targetPage.evaluate(() => {
        const player = window.JKDemoPlayer || window.OpenJKPlayer;
        if (!player || typeof player.getStatus !== "function") {
          return null;
        }
        return player.getStatus();
      });
      if (status && status.ready) {
        if (!requirePlaying || status.isPlaying || status.serverTime > 0) {
          return status;
        }
      }
    } catch (_) {
      // Ignore transient execution context destruction during navigation
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  const lastStatus = await targetPage
    .evaluate(() => {
      const player = window.JKDemoPlayer || window.OpenJKPlayer;
      return player && typeof player.getStatus === "function" ? player.getStatus() : null;
    })
    .catch(() => null);
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for JKDemoPlayer ready/playing. Last status: ${JSON.stringify(
      lastStatus
    )}, pageErrors: ${JSON.stringify(pageErrors.slice(-5))}`
  );
}

async function handleCommand(msg) {
  const { cmd, params = {} } = msg;

  if (cmd === "ping") {
    return { status: "ok" };
  }

  if (cmd === "goto") {
    const p = await ensureBrowser();
    if (params.clearLogs) {
      consoleLogs = [];
      pageErrors = [];
      requestFailures = [];
    }
    await p.goto(params.url, {
      waitUntil: params.waitUntil || "domcontentloaded",
      timeout: params.timeout || 60000,
    });
    if (params.waitForReady !== false) {
      const status = await waitForPlayerReady(
        p,
        params.readyTimeout || 90000,
        params.requirePlaying !== false
      );
      return { status };
    }
    return { status: null };
  }

  if (cmd === "eval") {
    const p = await ensureBrowser();
    const fnBody = params.script;
    const arg = params.arg;
    const val = await p.evaluate(
      async ({ code, inputArg }) => {
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const fn = new AsyncFunction("arg", code);
        return await fn(inputArg);
      },
      { code: fnBody, inputArg: arg }
    );
    return val;
  }

  if (cmd === "canvas_screenshot") {
    const p = await ensureBrowser();
    const selector = params.selector || "#jk-canvas";
    const snap = await p.evaluate((sel) => {
      const canvas = document.querySelector(sel);
      if (!canvas) {
        throw new Error(`Canvas not found for selector: ${sel}`);
      }
      const player = window.JKDemoPlayer || window.OpenJKPlayer;
      const status = player && typeof player.getStatus === "function" ? player.getStatus() : {};
      const dataUrl = canvas.toDataURL("image/png");
      return {
        width: canvas.width,
        height: canvas.height,
        dataUrl,
        status,
      };
    }, selector);
    return snap;
  }

  if (cmd === "get_logs") {
    return {
      consoleLogs: consoleLogs.slice(-(params.limit || 500)),
      pageErrors: pageErrors.slice(),
      requestFailures: requestFailures.slice(),
    };
  }

  if (cmd === "clear_errors") {
    pageErrors = [];
    requestFailures = [];
    return { cleared: true };
  }

  if (cmd === "close") {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
      browser = null;
      page = null;
    }
    return { closed: true };
  }

  throw new Error(`Unknown RPC command: ${cmd}`);
}

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch (err) {
    process.stdout.write(
      RPC_PREFIX + JSON.stringify({ id: null, ok: false, error: `Invalid JSON: ${err.message}` }) + "\n"
    );
    return;
  }

  try {
    const result = await handleCommand(req);
    process.stdout.write(RPC_PREFIX + JSON.stringify({ id: req.id, ok: true, result }) + "\n");
    if (req.cmd === "close") {
      process.exit(0);
    }
  } catch (err) {
    process.stdout.write(
      RPC_PREFIX +
        JSON.stringify({
          id: req.id,
          ok: false,
          error: err && err.message ? err.message : String(err),
          stack: err && err.stack ? err.stack : "",
        }) +
        "\n"
    );
  }
});

rl.on("close", async () => {
  if (browser) {
    try {
      await browser.close();
    } catch (_) {}
  }
  process.exit(0);
});
