#!/usr/bin/env node

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
  StdioServerTransport,
} = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const { SMART_SCROLL_SETTLE_MS, POLTERTAB_HOME } = require("./config.js");

const updates = require("./update-check.js");
const { BROWSER_TOOLS } = require("./tools.js");
const { writeOutput, summarizeOutput, rowsOf } = require("./output.js");
const {
  readMemory,
  saveMemory,
  getSelector,
  recordSelector,
  noteSelectorFail,
  selectorKey,
  pathPattern,
  listRecipeSummaries,
} = require("./memory.js");
const {
  hydrate,
  observe,
  noteStep,
  noteNavigation,
  redactValue,
  hintFor,
  describeRecipes,
  RECIPES_NOTE,
} = require("./recipes.js");
const { extractAll } = require("./extract-all.js");
const bridge = require("./bridge.js");
const OWN_VERSION = require("./../package.json").version;

let updateState = { latest: null, updateAvailable: false };
let noticeDelivered = false;

// Fire and forget at startup so the answer is ready by the first tool call.
// A rejected promise here must never reach the top level.
if (!updates.disabled()) {
  updates
    .checkForUpdate({ current: OWN_VERSION, home: POLTERTAB_HOME })
    .then((r) => {
      updateState = r;
    })
    .catch(() => {});
}

// Create MCP Server
const server = new Server(
  {
    name: "poltertab-browser-mcp",
    // Read, not hardcoded: this said "1.0.0" through every release, so the
    // version the client reported had nothing to do with what was installed.
    version: OWN_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: BROWSER_TOOLS,
  };
});

// Which page a tab (or a named session) is on, learned from the URL any
// navigate/get_url/action result reveals — no extra round-trip to ask. The
// selector store is keyed by this, so it has to be the page the click actually
// lands on.
const pageByTab = new Map();
const pageBySession = new Map();
let lastPage = null;

function pageOf(url) {
  try {
    const u = new URL(url);
    return u.hostname ? { host: u.hostname, path: u.pathname } : null;
  } catch {
    return null;
  }
}

function rememberPage(args, result) {
  const page = pageOf(result && result.url);
  if (!page) return;
  const tabId = (result && result.tabId) ?? (args && args.tabId);
  if (tabId != null) pageByTab.set(tabId, page);
  if (args && args.session) pageBySession.set(args.session, page);
  lastPage = page;
}

// An explicitly targeted tab or session resolves to ITS OWN page or to nothing.
// Falling back to a process-global here is how a click in session s1 ended up
// keyed to whatever host s2 had navigated to most recently — and `session` is
// the documented multi-tab mechanism, so that path is normal usage, not a
// corner case. No page means no healing, which is the safe direction.
function pageFor(args) {
  const a = args || {};
  if (a.session) return pageBySession.get(a.session) || null;
  if (a.tabId != null) return pageByTab.get(a.tabId) || null;
  return lastPage;
}

// The step buffer's key, resolved by exactly the same rule as pageFor: an
// explicit session or tab gets its own and never falls through to the
// process-global one. Without that, two concurrent tasks in two tabs borrow
// each other's preamble — the O13 failure, one layer up.
function targetKeyFor(args) {
  const a = args || {};
  if (a.session) return `session:${a.session}`;
  if (a.tabId != null) return `tab:${a.tabId}`;
  return "last";
}

// Actions worth remembering as a recipe's preamble: the facet click, the
// "100 per page", the scroll that loaded the list.
const RECORDED = new Set(["click", "fill", "hover", "scroll", "smart_scroll"]);

// Bookkeeping for an action that has already happened, so it can never throw
// at the caller. A fill's value goes through redactValue and nowhere else: the
// store is a plaintext file in the user's home directory.
function noteStepFor(action, args, targetKey, page, result) {
  try {
    const { value, redacted } = redactValue(
      action,
      args,
      result && result.fingerprint,
    );
    noteStep(targetKey, {
      action,
      selector: (args && args.selector) || null,
      path: page && page.path,
      host: page && page.host,
      // Nothing at all for a redacted fill, not the null redactValue reports:
      // a stored `value: null` reads back as "this field was filled with
      // nothing", which is a different step from the one that happened.
      value: redacted ? undefined : value,
      redacted,
    });
  } catch (_) {
    // A preamble we failed to record is a recipe with fewer steps, not a
    // failed action.
  }
}

// Recall has to be implicit — the tool surface is already 23 schemas on every
// request — so a navigate says what has been learned about where it landed.
// One memory read, and nothing at all on a host with no recipes.
function onNavigate(args, targetKey, result) {
  try {
    const dest = pageOf(result && result.url);
    if (!dest) return result;
    noteNavigation(targetKey, dest.host);
    const known = listRecipeSummaries(dest.host, pathPattern(dest.path));
    if (!known.length) return result;
    return { ...result, recipes_available: hintFor(known) };
  } catch (_) {
    // The navigation succeeded; a missing hint is the lesser evil.
    return result;
  }
}

const handleToolCall = async (request) => {
  const { name, arguments: args } = request.params;

  if (!name.startsWith("browser_")) {
    throw new Error(`Tool not found: ${name}`);
  }

  const action = name.replace("browser_", "");

  try {
    // Custom handling for network state tool
    if (action === "get_network_state") {
      const opts = args || {};
      let responsePayload;

      if (bridge.isSecondary()) {
        // Proxy it to the Primary — it is the one holding the capture buffer.
        responsePayload = await bridge.sendCommand("get_network_state", opts);
      } else {
        responsePayload = await bridge.readNetworkState(opts);
        bridge.noteActiveTab(responsePayload.tabId);
      }

      // Must be honoured in BOTH roles. A Secondary that returned the raw
      // payload would flood the very context window this parameter exists to
      // protect.
      if (opts.output_file) {
        const written = writeOutput(opts.output_file, responsePayload);
        return {
          content: [
            {
              type: "text",
              text: `Data successfully written to ${written.file}. Captured ${responsePayload.capturedRequests} requests.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(responsePayload, null, 2),
          },
        ],
      };
    }

    // Custom handling for smart scroll
    if (action === "smart_scroll") {
      const scrollResult = await bridge.sendCommand("scroll", args || {});
      bridge.noteActiveTab(scrollResult && scrollResult.tabId);

      // The scroll that loaded the list is part of the preamble a recipe
      // replays, and this branch returns before the generic path can see it.
      noteStepFor(
        "smart_scroll",
        args,
        targetKeyFor(args),
        pageFor(args),
        scrollResult,
      );

      // Wait for network requests to arrive (lazy loading)
      await new Promise((r) => setTimeout(r, SMART_SCROLL_SETTLE_MS));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...scrollResult,
                note: "Waited 2s for network data. Use browser_get_network_state to read.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Custom handling for setting intercept patterns globally via storage, then updating current tab
    if (action === "set_intercept_patterns") {
      const result = await bridge.sendCommand("set_intercept_patterns", args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (action === "get_site_memory") {
      const host = args.hostname || args.domain || args.url;
      if (!host) throw new Error("Missing 'hostname' parameter");
      // The agent's own notes, plus what it worked out about extracting the
      // site. The selectors map stays out: it is internal plumbing for
      // self-healing and would just be noise here.
      const memory = readMemory(host);
      const payload = { notes: memory.notes };
      const learned = describeRecipes(memory.recipes);
      if (learned.length) {
        payload.recipes = learned;
        payload.recipes_note = RECIPES_NOTE;
      }
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    }

    if (action === "save_site_memory") {
      const host = args.hostname || args.domain || args.url;
      if (!host) throw new Error("Missing 'hostname' parameter");
      saveMemory(host, args.obstacle, args.solution);
      return {
        content: [{ type: "text", text: "Memory successfully saved." }],
      };
    }

    // Loops in the server, not in the model. One tool call covers every page.
    if (action === "extract_all") {
      const opts = args || {};
      const targetKey = targetKeyFor(opts);
      // The page a recipe belongs to comes from the template, not from the tab:
      // this tool drives its own navigation, so the tab can be anywhere. The
      // inner sendCommand("extract", spec) calls always carry an explicit spec
      // and so are never hydrated.
      const page = pageOf(String(opts.url_template || "").replace("{page}", "1"));
      const ctx = hydrate("extract_all", opts, page);

      const payload = await extractAll(bridge.sendCommand, opts);
      const patch = ctx
        ? observe({ action, args: opts, result: payload, ctx, targetKey })
        : null;
      const out = patch ? { ...payload, ...patch } : payload;

      if (opts.output_file) {
        const written = writeOutput(opts.output_file, out, out.rows);
        const { rows, pages, ...rest } = out;
        const summary = {
          ...rest,
          ...written,
          fields: rows.length ? Object.keys(rows[0]) : [],
          sample: rows.slice(0, 2),
        };
        return {
          content: [
            { type: "text", text: JSON.stringify(summary, null, 2) },
          ],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      };
    }

    // Self-healing: for click/fill, supply a remembered fingerprint when the
    // selector has no explicit one, and remember the fingerprint that worked so
    // a later drift can be relocated. Keyed by the page the action lands on and
    // by the action itself — see memory.selectorKey.
    const healable = action === "click" || action === "fill";
    const selector = args && args.selector;
    // Resolved for every action, not just a healable click: the recipe layer
    // is keyed by the same page the selector store is.
    const page = pageFor(args);
    const key =
      healable && selector && page
        ? selectorKey(action, page.path, selector)
        : null;
    if (key && !args.fingerprint) {
      // Reading the store must never stop a click that would otherwise work.
      try {
        const stored = getSelector(page.host, key);
        if (stored) args.fingerprint = stored.fingerprint;
      } catch (_) {
        // Unreadable store: proceed on the caller's own selector.
      }
    }

    // Recipes live in the generic path on purpose: hydrate a missing extract
    // spec before the command goes out, judge what came back after. A second
    // `if (action === "extract")` branch would need its own copy of
    // output_file, tab tracking and page learning. Throwing before sendCommand
    // is deliberate too — an extract with no record selector is not a cheap
    // mistake, it returns the page's whole text as one row.
    const targetKey = targetKeyFor(args);
    const ctx = hydrate(action, args, page);

    let result;
    try {
      result = await bridge.sendCommand(action, args || {});
    } catch (err) {
      // A selector that missed even with its stored fingerprint is drifting;
      // enough misses and memory.js stops trusting it. Bookkeeping only — it
      // must not replace the error the caller needs to see.
      if (key && /not found/i.test(err.message)) {
        try {
          noteSelectorFail(page.host, key);
        } catch (_) {
          // Best effort.
        }
      }
      throw err;
    }
    bridge.noteActiveTab((result && result.tabId) || (args && args.tabId));

    // Learn the page for later, and store the fingerprint of what resolved.
    // Wrapped because the browser has ALREADY acted: a failure here would be
    // reported as a failed click, and the agent would retry and double-submit.
    try {
      rememberPage(args, result);
      if (key && result && result.fingerprint) {
        recordSelector(page.host, key, result.fingerprint);
      }
    } catch (_) {
      // The action succeeded; losing the bookkeeping is the lesser evil.
    }

    // Recorded only once the browser has confirmed the action, so a stored
    // preamble never replays a click that never landed.
    if (RECORDED.has(action)) {
      noteStepFor(action, args, targetKey, page, result);
    }

    if (action === "navigate") result = onNavigate(args, targetKey, result);

    // Patched before the output_file branch below: a run that writes to disk
    // is exactly the run where the model cannot see the rows for itself, so
    // losing used_recipe/stale there would hide a replay entirely.
    const patch = ctx
      ? observe({ action, args, result, ctx, targetKey })
      : null;
    if (patch) result = { ...result, ...patch };

    // Any read tool can send its payload to disk. Placed after tab tracking so
    // taking the file path does not cost the session its tab bookkeeping.
    if (args && args.output_file && result && typeof result === "object") {
      const rows = rowsOf(result);
      const written = writeOutput(args.output_file, result, rows);
      const summary = summarizeOutput(result, rows, written);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              patch ? { ...summary, ...patch } : summary,
              null,
              2,
            ),
          },
        ],
      };
    }

    // Check if error result string (graceful error handling)
    if (
      typeof result === "string" &&
      result.includes("Cannot interact with this page")
    ) {
      return {
        isError: true,
        content: [{ type: "text", text: result }],
      };
    }

    // Format output
    const textResult =
      typeof result === "object"
        ? JSON.stringify(result, null, 2)
        : String(result);

    return {
      content: [
        {
          type: "text",
          text: textResult,
        },
      ],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: err.message || "Unknown error executing browser command",
        },
      ],
    };
  }
};

// Update and skew notices ride out on the first tool response and never again.
// Doctor and the extension popup both require the user to already suspect
// something is wrong; the agent's reply is the one place they are certainly
// looking. Appended as its own content block so it cannot corrupt a payload
// something downstream is parsing.
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const result = await handleToolCall(request);
  if (noticeDelivered) return result;

  const text = updates.notice({
    current: OWN_VERSION,
    latest: updateState.latest,
    updateAvailable: updateState.updateAvailable,
    skew: updates.skew(OWN_VERSION, bridge.extensionVersion()),
  });
  if (!text) return result;

  noticeDelivered = true;
  if (!result || !Array.isArray(result.content)) return result;
  return { ...result, content: [...result.content, { type: "text", text }] };
});

// Start the server
async function startMcp() {
  bridge.start();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const reset = "\x1b[0m";
  const dim = "\x1b[2m";
  const cyan = "\x1b[36m";
  const purple = "\x1b[35m";
  const bold = "\x1b[1m";

  console.error(`
${purple}╭─────────────────────────────────────────────────────────────────╮${reset}
${purple}│${reset}  ${bold}POLTERTAB${reset}                                                      ${purple}│${reset}
${purple}│${reset}  ${dim}Phantom Browser Automation • Your Profile, Zero Headless${reset}       ${purple}│${reset}
${purple}╰─────────────────────────────────────────────────────────────────╯${reset}

  ${cyan}●${reset} MCP Server             ${bold}[ ACTIVE ]${reset}    ${dim}Connected to stdio transport${reset}
  ${cyan}○${reset} Extension Connection   ${bold}[ WAITING ]${reset}   ${dim}Listening on WebSocket...${reset}

${dim}The AI is now haunting your browser...${reset}
  `);
}

startMcp().catch((err) => {
  console.error("[PolterTab MCP] Failed to start server:", err);
  process.exit(1);
});
