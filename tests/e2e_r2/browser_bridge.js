#!/usr/bin/env node
/**
 * Persistent Headless Chrome (Puppeteer) JSON-RPC Bridge for OpenJK Round 2 E2E Tests.
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
let networkResponses = [];

function attachPageListeners(targetPage) {
  targetPage.on("console", (msg) => {
    const text = msg.text();
    consoleLogs.push({
      type: msg.type(),
      text,
      ts: Date.now(),
    });
    if (consoleLogs.length > 3000) {
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

  targetPage.on("response", (res) => {
    try {
      const url = res.url();
      const headers = res.headers() || {};
      const status = res.status();
      if (
        url.includes("/base/") ||
        url.includes("/jkplayer/") ||
        url.includes("openjk.") ||
        url.includes("getdemo") ||
        url.includes("mergedemo") ||
        url.includes("trimdemo") ||
        url.includes("matchdemo") ||
        url.includes("rpc")
      ) {
        networkResponses.push({
          url,
          status,
          contentType: headers["content-type"] || "",
          contentLength: parseInt(headers["content-length"] || "0", 10) || 0,
          contentRange: headers["content-range"] || "",
          acceptRanges: headers["accept-ranges"] || "",
          cacheControl: headers["cache-control"] || "",
          ts: Date.now(),
        });
        if (networkResponses.length > 3000) {
          networkResponses.shift();
        }
      }
    } catch (_) {}
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
  await page.setViewport({ width: 1440, height: 900 });
  consoleLogs = [];
  pageErrors = [];
  requestFailures = [];
  networkResponses = [];
  attachPageListeners(page);
  return page;
}

async function waitForCondition(targetPage, predicateCode, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await targetPage.evaluate((code) => {
        const fn = new Function(code);
        return fn();
      }, predicateCode);
      if (res) {
        return res;
      }
    } catch (_) {
      // Ignore transient navigation execution context errors
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for condition. Recent pageErrors: ${JSON.stringify(
      pageErrors.slice(-5)
    )}`
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
      networkResponses = [];
    }
    if (params.viewportWidth && params.viewportHeight) {
      await p.setViewport({
        width: Number(params.viewportWidth),
        height: Number(params.viewportHeight),
      });
    }
    await p.goto(params.url, {
      waitUntil: params.waitUntil || "domcontentloaded",
      timeout: params.timeout || 60000,
    });
    if (params.waitCondition) {
      const condResult = await waitForCondition(
        p,
        params.waitCondition,
        params.readyTimeout || 90000
      );
      return { url: p.url(), condResult };
    }
    return { url: p.url() };
  }

  if (cmd === "set_viewport") {
    const p = await ensureBrowser();
    await p.setViewport({
      width: Number(params.width || 1440),
      height: Number(params.height || 900),
    });
    return { width: params.width || 1440, height: params.height || 900 };
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
      let canvas = document.querySelector(sel);
      let win = window;
      if (!canvas) {
        const iframes = document.querySelectorAll("iframe");
        for (const f of iframes) {
          try {
            if (f.contentDocument) {
              const c = f.contentDocument.querySelector(sel);
              if (c) {
                canvas = c;
                win = f.contentWindow || window;
                break;
              }
            }
          } catch (_) {}
        }
      }
      if (!canvas) {
        throw new Error(`Canvas not found for selector: ${sel}`);
      }
      const player =
        win.JKDemoPlayer ||
        win.OpenJKPlayer ||
        window.JKDemoPlayer ||
        window.OpenJKPlayer;
      const status =
        player && typeof player.getStatus === "function"
          ? player.getStatus()
          : player && typeof player.getStats === "function"
          ? player.getStats()
          : {};
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
      networkResponses: networkResponses.slice(-(params.netLimit || 1000)),
    };
  }

  if (cmd === "clear_errors") {
    pageErrors = [];
    requestFailures = [];
    if (params.clearNet) {
      networkResponses = [];
    }
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
      RPC_PREFIX +
        JSON.stringify({ id: null, ok: false, error: `Invalid JSON: ${err.message}` }) +
        "\n"
    );
    return;
  }

  try {
    const result = await handleCommand(req);
    process.stdout.write(
      RPC_PREFIX + JSON.stringify({ id: req.id, ok: true, result }) + "\n"
    );
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
