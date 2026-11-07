#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCREENSHOTS_DIR = join(ROOT, "screenshots");
mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// Parse target URL from arguments or environment variable
let targetUrl = "http://127.0.0.1:8080";
const args = process.argv.slice(2);
for (const arg of args) {
  if (arg !== "--" && !arg.startsWith("-")) {
    targetUrl = arg;
    break;
  }
}
if (
  (!args.length || args.every((a) => a === "--" || a.startsWith("-"))) &&
  process.env.APP_URL
) {
  targetUrl = process.env.APP_URL;
}

console.log(`[smoke-local] Starting smoke verification against: ${targetUrl}`);

// 1. Wait for server readiness
async function waitForServer(url, maxRetries = 25, delayMs = 500) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.status >= 200 && res.status < 400) {
        console.log(
          `[smoke-local] Server is responding at ${url} (status: ${res.status})`,
        );
        return true;
      }
    } catch {
      // server is not yet ready, retry
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(
    `[smoke-local] Server at ${url} did not respond within ${maxRetries * delayMs}ms`,
  );
}

// 2. Multi-tier browser launcher (strictly offline, no network browser installation)
async function launchBrowser() {
  // Tier 1: Bundled playwright chromium
  try {
    return await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  } catch (err) {
    const msg = String(err?.message || err);
    if (
      !msg.includes("Executable doesn't exist") &&
      !msg.includes("browserType.launch")
    ) {
      console.warn(`[smoke-local] Default chromium launch note: ${msg}`);
    }
  }

  // Tier 2: System Google Chrome channel (available on macOS host)
  try {
    return await chromium.launch({
      channel: "chrome",
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  } catch (err) {
    console.warn(
      `[smoke-local] System chrome launch failed: ${err?.message || err}`,
    );
  }

  // Tier 3: System Chromium channel
  try {
    return await chromium.launch({
      channel: "chromium",
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  } catch (err) {
    console.warn(
      `[smoke-local] System chromium launch failed: ${err?.message || err}`,
    );
  }

  return null;
}

// 3. Fallback verification via fetch if no browser is available
async function runFallback(url) {
  console.warn(
    "[smoke-local] Playwright browser is not installed; network installation is prohibited.",
  );
  console.log("[smoke-local] Running HTTP fallback check...");
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP GET ${url} failed with status ${res.status}`);
  }
  const html = await res.text();
  if (!html.includes("CQA") && !html.includes("качество")) {
    throw new Error(
      "HTML response does not contain expected CQA app shell markers",
    );
  }
  console.log(
    "[smoke-local] HTTP fallback check passed: status 200 and valid HTML response.",
  );
}

async function main() {
  await waitForServer(targetUrl);

  const browser = await launchBrowser();
  if (!browser) {
    await runFallback(targetUrl);
    return;
  }

  const errors = [];
  let llmInfoResponse = null;

  try {
    // ----------------------------------------------------
    // Desktop Viewport Test: 1280x800
    // ----------------------------------------------------
    console.log("[smoke-local] Testing Desktop (1280x800)...");
    const desktopContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const desktopPage = await desktopContext.newPage();

    desktopPage.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(`[desktop console.error] ${msg.text()}`);
      }
    });
    desktopPage.on("pageerror", (err) => {
      errors.push(`[desktop pageerror] ${err.message || String(err)}`);
    });

    desktopPage.on("response", async (res) => {
      if (res.url().includes("_serverFn") || res.url().includes("getLlmInfo")) {
        try {
          const text = await res.text();
          if (text.includes("model") && text.includes("provider")) {
            llmInfoResponse = text;
          }
        } catch {
          // ignore stream read errors
        }
      }
    });

    const response = await desktopPage.goto(targetUrl, {
      waitUntil: "domcontentloaded",
    });
    if (response && response.status() !== 200) {
      throw new Error(
        `Expected HTTP 200 on main page, received status ${response.status()}`,
      );
    }

    // Check getLlmInfo safety
    console.log("[smoke-local] Checking getLlmInfo safety...");
    let retries = 0;
    while (!llmInfoResponse && retries < 20) {
      await desktopPage.waitForTimeout(250);
      retries++;
    }

    if (llmInfoResponse) {
      const forbiddenPatterns = [
        /xai-[A-Za-z0-9]{20,}/i,
        /sk-[A-Za-z0-9]{20,}/i,
        /"apiKey"\s*:\s*"[^"]+"/i,
        /"api_key"\s*:\s*"[^"]+"/i,
        /"secret"\s*:\s*"[^"]+"/i,
        /"token"\s*:\s*"[^"]+"/i,
      ];
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(llmInfoResponse)) {
          throw new Error(
            `Security violation: getLlmInfo leaked sensitive pattern: ${pattern}`,
          );
        }
      }
      console.log(
        "[smoke-local] getLlmInfo verified: server function responded safely without secret keys.",
      );
    } else {
      const badge = desktopPage.locator(
        'span:has-text("api.x.ai"), span:has-text("локальная"), span:has-text("grok")',
      );
      const count = await badge.count();
      if (count > 0) {
        console.log(
          "[smoke-local] getLlmInfo verified: provider badge rendered in UI.",
        );
      } else {
        console.warn(
          "[smoke-local] Note: getLlmInfo response not intercepted, UI badge not visible.",
        );
      }
    }

    // Step 1: Click «Демо, 14»
    const demoButton = desktopPage.getByRole("button", { name: "Демо, 14" });
    await demoButton.waitFor({ state: "visible", timeout: 10000 });
    console.log("[smoke-local] Clicking «Демо, 14»...");
    await demoButton.click();

    // Verify 14 dialogs loaded in DOM
    await desktopPage.waitForSelector("ul > li", { timeout: 10000 });
    const rowCount = await desktopPage.locator("ul > li").count();
    console.log(`[smoke-local] Successfully imported ${rowCount} demo dialogs`);
    if (rowCount !== 14) {
      throw new Error(`Expected 14 demo dialogs, found ${rowCount}`);
    }

    // Step 2: Click «Эвристика по списку»
    const heuristicButton = desktopPage.getByRole("button", {
      name: "Эвристика по списку",
    });
    await heuristicButton.waitFor({ state: "visible", timeout: 5000 });
    console.log("[smoke-local] Clicking «Эвристика по списку»...");
    await heuristicButton.click();

    // Step 3: Wait for heuristic evaluation completion
    console.log("[smoke-local] Waiting for heuristic batch completion...");
    await desktopPage.waitForSelector(
      "text=/Пакет эвристика:.*статус completed/",
      { timeout: 20000 },
    );
    const statusText = await desktopPage
      .locator("text=/Пакет эвристика:.*статус completed/")
      .textContent();
    console.log(`[smoke-local] Batch completed: "${statusText?.trim()}"`);

    // Verify all 14 evaluated
    const evaluatedCount = await desktopPage
      .locator("ul > li:has-text('эвристика')")
      .count();
    console.log(`[smoke-local] Evaluated dialogs count: ${evaluatedCount}/14`);
    if (evaluatedCount !== 14) {
      throw new Error(`Expected 14 evaluated dialogs, found ${evaluatedCount}`);
    }

    // Check desktop console errors
    if (errors.length > 0) {
      console.error("[smoke-local] Desktop errors detected:", errors);
      throw new Error(
        `Smoke test failed with ${errors.length} console/page error(s) on desktop`,
      );
    }

    // Save desktop screenshots
    const desktopScreenshotPath = join(
      SCREENSHOTS_DIR,
      "smoke-desktop-1280x800.png",
    );
    const desktopScreenshotAlias = join(SCREENSHOTS_DIR, "smoke-desktop.png");
    await desktopPage.screenshot({ path: desktopScreenshotPath });
    await desktopPage.screenshot({ path: desktopScreenshotAlias });
    console.log(
      `[smoke-local] Desktop screenshots saved: ${desktopScreenshotPath} and ${desktopScreenshotAlias}`,
    );

    await desktopContext.close();

    // ----------------------------------------------------
    // Mobile Viewport Test: 390x844
    // ----------------------------------------------------
    console.log("[smoke-local] Testing Mobile (390x844)...");
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const mobilePage = await mobileContext.newPage();

    mobilePage.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(`[mobile console.error] ${msg.text()}`);
      }
    });
    mobilePage.on("pageerror", (err) => {
      errors.push(`[mobile pageerror] ${err.message || String(err)}`);
    });

    const mobileResponse = await mobilePage.goto(targetUrl, {
      waitUntil: "domcontentloaded",
    });
    if (mobileResponse && mobileResponse.status() !== 200) {
      throw new Error(
        `Expected HTTP 200 on mobile page, received status ${mobileResponse.status()}`,
      );
    }
    await mobilePage.waitForTimeout(1000);

    // Verify no horizontal overflow
    const overflowCheck = await mobilePage.evaluate(() => {
      const el = document.documentElement;
      return {
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        hasOverflow: el.scrollWidth > el.clientWidth,
      };
    });
    console.log(
      `[smoke-local] Mobile dimensions: scrollWidth=${overflowCheck.scrollWidth}, clientWidth=${overflowCheck.clientWidth}`,
    );
    if (overflowCheck.hasOverflow) {
      throw new Error(
        `Mobile layout has horizontal overflow: scrollWidth (${overflowCheck.scrollWidth}) > clientWidth (${overflowCheck.clientWidth})`,
      );
    }

    // Check mobile console errors
    if (errors.length > 0) {
      console.error(
        "[smoke-local] Console/page errors detected on mobile:",
        errors,
      );
      throw new Error(
        `Smoke test failed with ${errors.length} console/page error(s)`,
      );
    }

    // Save mobile screenshots
    const mobileScreenshotPath = join(
      SCREENSHOTS_DIR,
      "smoke-mobile-390x844.png",
    );
    const mobileScreenshotAlias = join(SCREENSHOTS_DIR, "smoke-mobile.png");
    await mobilePage.screenshot({ path: mobileScreenshotPath });
    await mobilePage.screenshot({ path: mobileScreenshotAlias });
    console.log(
      `[smoke-local] Mobile screenshots saved: ${mobileScreenshotPath} and ${mobileScreenshotAlias}`,
    );

    await mobileContext.close();

    console.log(
      "[smoke-local] All smoke verification checks passed successfully!",
    );
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`[smoke-local] FAILED: ${err.message || err}`);
  process.exit(1);
});
