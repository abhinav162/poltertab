// The tool surface: what the model can see and call. Data only — every handler
// lives in index.js. Kept apart because this is the file that changes whenever
// a capability is added or a description is reworded, and it was 27% of a
// 1,600-line index.js that also held the transport, the writers and the loop.

// Every page-facing tool accepts the same two targeting parameters and, if it
// reads anything back, the same sink. They were copy-pasted into all 23 schemas,
// which is how `session` ended up described on browser_navigate and nowhere else
// — fifteen tools offered the model a bare string with no hint what it does.
const TARGET = {
  tabId: {
    type: "number",
    description: "Target a specific tab. Omit to use the last tab navigated.",
  },
  session: {
    type: "string",
    description:
      "Named session (tab) to run against. Created on first use by browser_navigate, so a loop can keep one tab instead of opening hundreds.",
  },
};

// One description, because writeOutput's behaviour is uniform: records become
// .jsonl/.csv when the extension asks for them, everything else is JSON.
const SINK = {
  output_file: {
    type: "string",
    description:
      "Filename to write the payload under ~/.poltertab/downloads/, returning only a summary (row count, field names, fill rates, two sample records). .jsonl and .csv are written in those formats when the payload carries records, anything else as JSON. A path is reduced to its basename — output cannot be written elsewhere.",
  },
};

// Self-healing: browser_click/browser_fill return the resolved element's
// fingerprint. Pass it back on a later call and, if the selector has drifted
// (a renamed id/class), the element is relocated by structural similarity.
const FINGERPRINT = {
  fingerprint: {
    type: "object",
    description:
      "Optional. The `fingerprint` object a previous browser_click/browser_fill returned for this element. When the selector no longer matches, the element is relocated by structural similarity and the result carries healed:true.",
  },
};

// Define tools
const BROWSER_TOOLS = [
  {
    name: "browser_navigate",
    description: "Navigate to any URL in the browser",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        ...TARGET,
      },
      required: ["url"],
    },
  },
  {
    name: "browser_click",
    description:
      "Click an element on the page. Returns the element's `fingerprint` (pass it back later to survive a selector change) and `healed:true` if the selector had drifted and the element was relocated.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        ...FINGERPRINT,
        ...TARGET,
      },
      required: ["selector"],
    },
  },
  {
    name: "browser_fill",
    description:
      "Fill an input field with text. Returns the field's `fingerprint` (pass it back later to survive a selector change) and `healed:true` if the selector had drifted and the field was relocated.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        value: { type: "string" },
        submit: { type: "boolean" },
        ...FINGERPRINT,
        ...TARGET,
      },
      required: ["selector", "value"],
    },
  },
  {
    name: "browser_scrape",
    description:
      "Scrape the page or specific elements. For repeating records (cards, rows, listings) use browser_extract instead — it keeps fields grouped per record.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        attribute: {
          type: "string",
          description:
            "Attribute to read, or 'text' for the element's text. 'href'/'src' come back absolute.",
        },
        multiple: { type: "boolean" },
        fields: {
          type: "array",
          items: {
            type: "string",
            enum: ["meta", "jsonld", "links", "headings", "bodyText"],
          },
          description:
            "Full-page scrape only (no selector): which parts to return. title and url are always included. ['meta','jsonld'] is the cheap structured-data path — og: tags and schema.org blobs without 50KB of body text. Omit for everything.",
        },
        max_text: {
          type: "number",
          description: "Max characters of text per element (default 500)",
        },
        ...SINK,
        ...TARGET,
      },
      required: [],
    },
  },
  {
    name: "browser_extract",
    description:
      "Extract repeating records (cards, rows, listings) with fields grouped per record. Fields resolve INSIDE each record root and a missing field yields null instead of shifting later records' values. Returns fill rates and warns when a field is empty inside the record scope but matches page-wide (record boundary too narrow).",
    inputSchema: {
      type: "object",
      properties: {
        record: {
          type: "string",
          description:
            "Selector for the repeating container, e.g. '.agent-card'. Verify with browser_snapshot that it encloses ALL the fields you want — the element that looks like the card often excludes siblings holding some of them.",
        },
        fields: {
          type: "object",
          description:
            "Map of field name -> {sel, get, many, strip}. sel is relative to the record root; omit it (or use '.') for the root itself. get: 'text' (default) | 'href' | 'src' | any attribute name. many: true collects all matches into an array. strip removes a leading prefix, e.g. 'tel:'.",
          additionalProperties: {
            type: "object",
            properties: {
              sel: { type: "string" },
              get: { type: "string" },
              many: { type: "boolean" },
              strip: { type: "string" },
            },
          },
        },
        anchor: {
          type: "string",
          description:
            "Name of the field that is always present on a real record (usually the detail-page link). Records missing it are dropped as placeholders and counted in 'dropped'.",
        },
        max_text: {
          type: "number",
          description: "Max characters per text field (default 500)",
        },
        probe: {
          type: "boolean",
          description:
            "Page-wide re-check of any field that came back entirely empty (default true)",
        },
        ...SINK,
        ...TARGET,
      },
      required: ["record", "fields"],
    },
  },
  {
    name: "browser_extract_all",
    description:
      "Paginate and extract in one call, with no model round-trip per page. Takes browser_extract's spec plus a URL template, walks pages, dedups on a key, and halts on: limit reached, empty page, a page whose records repeat an earlier page's (the trap where ignored page-size params silently return page 1 again), fill rates collapsing against page 1's baseline, or max_pages. Always reports which condition fired and returns everything collected so far.",
    inputSchema: {
      type: "object",
      properties: {
        url_template: {
          type: "string",
          description:
            "URL with a {page} placeholder, e.g. 'https://www.kw.com/agents?page={page}'",
        },
        record: { type: "string" },
        fields: { type: "object" },
        anchor: { type: "string" },
        key: {
          type: "string",
          description:
            "Field name to dedup on — use a stable per-record identifier such as the detail URL. Falls back to whole-row equality.",
        },
        limit: {
          type: "number",
          description: "Stop after this many records (default 200)",
        },
        offset: {
          type: "number",
          description:
            "Skip this many records from the start of the stream. Pages are re-fetched to reach the offset; pass start_page to skip cheaply.",
        },
        start_page: { type: "number", description: "First page (default 1)" },
        max_pages: {
          type: "number",
          description: "Hard guard on pages fetched (default 50)",
        },
        fill_tolerance: {
          type: "number",
          description:
            "Halt when a field well-populated on the baseline page falls below this fraction of it (default 0.5). 0 disables the check.",
        },
        max_text: { type: "number" },
        ...SINK,
        // Session only, deliberately: this tool drives its own navigation from
        // url_template, so a tabId would be accepted and then ignored.
        session: TARGET.session,
      },
      required: ["url_template", "record", "fields"],
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Capture visible tab as base64 PNG. This action will focus the target tab.",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET,
      },
      required: [],
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll the page",
    inputSchema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right", "top", "bottom"],
        },
        amount: { type: "number" },
        selector: { type: "string" },
        ...TARGET,
      },
      required: ["direction"],
    },
  },
  {
    name: "browser_hover",
    description: "Hover over an element",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        ...TARGET,
      },
      required: ["selector"],
    },
  },
  {
    name: "browser_get_text",
    description: "Get text content of an element",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        max_text: {
          type: "number",
          description:
            "Max characters (default 10000). The result flags it when text was cut.",
        },
        ...SINK,
        ...TARGET,
      },
      required: ["selector"],
    },
  },
  {
    name: "browser_get_title",
    description: "Get page title and URL",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET,
      },
      required: [],
    },
  },
  {
    name: "browser_get_url",
    description: "Get page URL",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET,
      },
      required: [],
    },
  },
  {
    name: "browser_snapshot",
    description:
      "Get a snapshot of the DOM. Large pages run to tens of KB — narrow it with interactive_only/max_nodes, or send it to output_file, before spending the context on it.",
    inputSchema: {
      type: "object",
      properties: {
        interactive_only: {
          type: "boolean",
          description: "Only clickable/typable elements",
        },
        max_nodes: {
          type: "number",
          description: "Cap on nodes returned (default 400)",
        },
        max_depth: { type: "number" },
        ...SINK,
        ...TARGET,
      },
      required: [],
    },
  },
  {
    name: "browser_get_network_state",
    description:
      "Get captured raw JSON data (GraphQL/XHR) for the current tab, bypassing DOM virtualization",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET,
        clear: {
          type: "boolean",
          description: "Clear the buffer after reading (default: true)",
        },
        ...SINK,
      },
      required: [],
    },
  },
  {
    name: "browser_set_intercept_patterns",
    description:
      "Set URL substrings to determine which network requests are captured in the MAIN world.",
    inputSchema: {
      type: "object",
      properties: {
        patterns: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of substrings (e.g. ['graphql', '/api/v1/comments'])",
        },
        ...TARGET,
      },
      required: ["patterns"],
    },
  },
  {
    name: "browser_smart_scroll",
    description:
      "Scroll the page and wait for new network data to load (handles lazy-loading)",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"] },
        amount: { type: "number" },
        ...TARGET,
      },
      required: ["direction"],
    },
  },
  {
    name: "browser_session_create",
    description: "Create or track a named browser session (tab)",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        url: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "browser_session_switch",
    description: "Switch to a different tracked session",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "browser_session_list",
    description: "List all tracked sessions",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "browser_session_close",
    description: "Close a tracked session",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "browser_session_context",
    description: "Get context info for the current active session",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "browser_get_site_memory",
    description:
      "Get navigation memory, obstacles, and fixes for a specific website domain",
    inputSchema: {
      type: "object",
      properties: {
        hostname: {
          type: "string",
          description: "e.g., 'www.linkedin.com' or 'x.com'",
        },
        domain: { type: "string", description: "Alias for hostname" },
      },
      required: [],
    },
  },
  {
    name: "browser_save_site_memory",
    description:
      "Save a new navigation memory, obstacle, or fix for a specific website domain",
    inputSchema: {
      type: "object",
      properties: {
        hostname: { type: "string", description: "e.g., 'www.linkedin.com'" },
        domain: { type: "string", description: "Alias for hostname" },
        obstacle: {
          type: "string",
          description: "What broke or was difficult?",
        },
        solution: { type: "string", description: "How did you solve it?" },
      },
      required: ["obstacle", "solution"],
    },
  },
];

module.exports = { BROWSER_TOOLS, TARGET, SINK };
