/**
 * browser - drive a live web app via playwright-cli (https://github.com/microsoft/playwright-cli)
 *
 * Wraps the globally installed `playwright-cli` as a pi tool. The CLI keeps a
 * persistent browser session per workspace, so state (login, localStorage,
 * page) survives between tool calls. Screenshots produced by a command are
 * attached to the tool result as images so the model can see them directly.
 *
 * Requirements:
 *   npm install -g @playwright/cli
 *   (first run downloads a chromium build if missing)
 *
 * A project-local .playwright/cli.config.json takes precedence. Otherwise a
 * global config (~/.pi/agent/playwright-cli.config.json) is injected on
 * `open` so the CLI uses plain chromium instead of the default chrome channel.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const GLOBAL_CONFIG_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "playwright-cli.config.json",
);

const GLOBAL_CONFIG = {
  browser: {
    browserName: "chromium",
    contextOptions: {
      viewport: { width: 1280, height: 800 },
    },
  },
};

function ensureGlobalConfig() {
  if (!fs.existsSync(GLOBAL_CONFIG_PATH)) {
    fs.mkdirSync(path.dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(GLOBAL_CONFIG, null, 2));
  }
}

/** Find .png paths mentioned in CLI output, resolved against cwd. */
function findScreenshots(output: string, cwd: string): string[] {
  const matches = output.match(/[^\s"'()[\]]+\.png\b/g) ?? [];
  const seen = new Set<string>();
  const files: string[] = [];

  for (const match of matches) {
    const resolved = path.resolve(cwd, match);
    if (!seen.has(resolved) && fs.existsSync(resolved)) {
      seen.add(resolved);
      files.push(resolved);
    }
  }

  return files;
}

export default function (pi: ExtensionAPI) {
  let openedBrowser = false;
  let lastCwd: string | undefined;

  pi.registerTool({
    name: "browser",
    label: "Browser",
    description: [
      "Drive a live web app through playwright-cli. A persistent browser session is kept per",
      "workspace, so page state, localStorage, and login survive between calls.",
      "",
      "The `command` is passed to playwright-cli verbatim. Typical flow:",
      "  1. open <url>                  start the browser and load the app",
      "  2. snapshot                    accessibility snapshot; gives element refs like e45",
      "  3. click e45 / fill e12 \"x\"    interact using refs from the latest snapshot",
      "  4. screenshot                  capture the page (attached to the result as an image)",
      "",
      "Other useful commands: type, press, hover, select, eval, resize <w> <h> (e.g. 390 844",
      "for phone-sized), localstorage-set <key> <value>, requests, go-back, reload, close.",
      "Run `--help` for the full list.",
      "",
      "Screenshots are attached inline; do not read the .png files separately. Default",
      "viewport is 1280x800 (project .playwright/cli.config.json overrides, else",
      "~/.pi/agent/playwright-cli.config.json).",
    ].join("\n"),
    promptSnippet: "Drive a live web app (open, snapshot, click, fill, screenshot) via playwright-cli",
    promptGuidelines: [
      "Use the browser tool to visually verify web UI changes against a running dev server: open the URL, interact via refs from snapshot, then screenshot.",
    ],
    parameters: Type.Object({
      command: Type.String({
        description:
          'playwright-cli arguments, e.g. \'open http://localhost:3000\', \'snapshot\', \'click e45\', \'fill e12 "hello"\', \'screenshot\'',
      }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const command = params.command.trim();
      let fullCommand = command;

      // Inject the global config on `open` unless the project has its own
      // config or one was passed explicitly.
      if (command.startsWith("open") && !command.includes("--config")) {
        const projectConfig = path.join(ctx.cwd, ".playwright", "cli.config.json");
        if (!fs.existsSync(projectConfig)) {
          ensureGlobalConfig();
          fullCommand = `${command} --config ${JSON.stringify(GLOBAL_CONFIG_PATH)}`;
        }
      }

      const result = await pi.exec("bash", ["-c", `playwright-cli ${fullCommand}`], {
        cwd: ctx.cwd,
        signal,
        timeout: 120_000,
      });

      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();

      if (result.code !== 0) {
        let hint = "";
        if (/command not found|not recognized/i.test(output)) {
          hint = "\n\nplaywright-cli is not installed. Install it with: npm install -g @playwright/cli";
        } else if (/is not found at|playwright install/i.test(output)) {
          hint =
            "\n\nBrowser binary missing. Install it with:\n" +
            "cd $(npm root -g)/@playwright/cli && node node_modules/playwright-core/cli.js install chromium";
        }
        throw new Error(`playwright-cli exited with code ${result.code}:\n${output}${hint}`);
      }

      if (command.startsWith("open")) {
        openedBrowser = true;
        lastCwd = ctx.cwd;
      } else if (command.startsWith("close")) {
        openedBrowser = false;
      }

      const truncation = truncateHead(output || "(no output)", {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      let text = truncation.content;
      if (truncation.truncated) {
        text += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines]`;
      }

      const content: (
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      )[] = [{ type: "text", text }];

      // Attach screenshots mentioned in the output (most recent last).
      for (const file of findScreenshots(output, ctx.cwd).slice(-2)) {
        const stat = fs.statSync(file);
        if (stat.size < 5_000_000) {
          content.push({
            type: "image",
            data: fs.readFileSync(file).toString("base64"),
            mimeType: "image/png",
          });
        }
      }

      return { content, details: {} };
    },
  });

  // Close the browser this session opened (best-effort).
  pi.on("session_shutdown", async () => {
    if (!openedBrowser) return;
    openedBrowser = false;
    try {
      await pi.exec("bash", ["-c", "playwright-cli close"], {
        cwd: lastCwd,
        timeout: 10_000,
      });
    } catch {
      // Browser may already be gone; nothing to do.
    }
  });
}
