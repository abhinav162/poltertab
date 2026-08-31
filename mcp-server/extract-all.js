// browser_extract_all: paginate a site and return records, so the model stops
// being the for-loop.
//
// sendCommand is injected rather than required, so this module has no opinion
// about whether it is talking to an extension directly or proxying through a
// Primary node — and so the suite can drive it with a scripted transport.

const { isBlank } = require("./output.js");

// --- The pagination loop ---
//
// This exists so the model stops being the for-loop. It supplies the spec once
// and receives records; every page in between costs a browser round-trip
// instead of a model round-trip.
//
// Every halt condition below is a case where continuing would produce data
// that looks complete and is not, so each one names itself in the result. A
// paused run costs far less than a confidently wrong dataset.
async function extractAll(sendCommand, args) {
  const {
    url_template,
    record,
    fields,
    anchor,
    key,
    limit = 200,
    offset = 0,
    start_page = 1,
    max_pages = 50,
    fill_tolerance = 0.5,
    max_text,
    session,
  } = args;

  if (!url_template.includes("{page}")) {
    throw new Error("url_template must contain a {page} placeholder");
  }

  const spec = { record, fields, anchor, max_text, session, probe: true };
  const target = offset + limit;
  const rows = [];
  const seen = new Set();
  const warnings = [];
  const pages = [];

  let baseline = null;
  let stopped_because = "max_pages";
  let page = start_page;
  let fetched = 0;

  const keyOf = (row) =>
    key ? String(row[key] ?? "") : JSON.stringify(row);

  while (fetched < max_pages) {
    const url = url_template.replace("{page}", String(page));
    const nav = await sendCommand("navigate", { url, session });
    fetched++;

    const res = await sendCommand("extract", spec);
    const pageRows = (res && res.rows) || [];
    pages.push({
      page,
      url: nav && nav.url,
      found: res ? res.records_found : 0,
      kept: pageRows.length,
      dropped: res ? res.dropped : 0,
    });
    if (res && res.warnings && res.warnings.length) {
      warnings.push(`page ${page}: ${res.warnings.join("; ")}`);
    }

    if (!pageRows.length) {
      stopped_because = "empty_page";
      break;
    }

    // A site that ignores an unrecognised page param answers every request with
    // page 1. Identical content reads as real data, which is how a "next 100"
    // silently becomes the same 12 records eight times over.
    const fresh = pageRows.filter((r) => !seen.has(keyOf(r)));
    if (!fresh.length) {
      stopped_because = "duplicate_page";
      warnings.push(
        `page ${page} returned only records already seen — pagination is not advancing`,
      );
      break;
    }

    // Fill rates against the first page. A spec learned on page 1 degrades
    // quietly later: variant card layouts, a column that stops being populated.
    // Halting beats emitting rows that are 40% empty.
    const ratios = {};
    for (const [name, n] of Object.entries(res.fill_rates || {})) {
      ratios[name] = n / pageRows.length;
    }
    if (!baseline) {
      baseline = ratios;
    } else if (fill_tolerance > 0) {
      const collapsed = Object.keys(baseline).filter(
        (name) =>
          baseline[name] >= 0.5 &&
          ratios[name] < baseline[name] * fill_tolerance,
      );
      if (collapsed.length) {
        stopped_because = "fill_rate_deviation";
        warnings.push(
          `page ${page}: ${collapsed
            .map(
              (n) =>
                `${n} ${(ratios[n] * 100).toFixed(0)}% vs baseline ${(baseline[n] * 100).toFixed(0)}%`,
            )
            .join(", ")} — page layout likely differs from the learned spec`,
        );
        break;
      }
    }

    for (const r of fresh) {
      seen.add(keyOf(r));
      rows.push(r);
    }

    if (rows.length >= target) {
      stopped_because = "limit_reached";
      break;
    }
    page++;
  }

  const sliced = rows.slice(offset, offset + limit);
  if (offset && fetched) {
    warnings.push(
      `offset ${offset} was reached by fetching from page ${start_page}; pass start_page to skip pages instead of re-reading them`,
    );
  }

  // extract reports fill as counts, so extract_all does too — the per-page
  // baseline is a fraction because it is compared across pages of differing
  // size, and carries the unit in its name rather than looking like a count.
  const fill_rates = {};
  for (const name of Object.keys(fields)) {
    fill_rates[name] = sliced.filter((r) => !isBlank(r[name])).length;
  }

  return {
    rows: sliced,
    count: sliced.length,
    collected: rows.length,
    pages_fetched: fetched,
    last_page: page,
    stopped_because,
    fill_rates,
    baseline_fill_ratios: baseline,
    pages,
    warnings,
  };
}

module.exports = { extractAll };
