// api/audit.js
// Vercel serverless function (Node.js, ESM) that queries the "Weekly Audit
// Records" Notion database and returns flag counts + structured per-record
// detail (tracked posts, tags, notes, links) for every audit week on record,
// growing automatically as new weeks are added.

const NOTION_VERSION = "2022-06-28";
const DATABASE_ID = "507ca77b-0245-4fb5-bb87-150b93f31910";
const WEEK_PROPERTY = "Week Of";
const EXECUTION_PROPERTY = "⚙️ Flag Execution";
const CREATIVE_PROPERTY = "🎨 Flag Creative";

// Dedicated fields for the Weekly Leaderboard tab — same table as the
// Notion "Weekly Dashboard" page (Client Name / Best Post Title / Max Post
// Views / Product Owner (Auto) / Pod, sorted by Max Post Views). These
// already flow into the generic tags array below too, but the leaderboard
// needs Max Post Views as a real number (not a locale-formatted string) to
// sort correctly, so they're pulled out as their own typed fields.
const BEST_POST_TITLE_PROPERTY = "🏆 Best Post Title";
const MAX_POST_VIEWS_PROPERTY = "🔝 Max Post Views";
const POD_PROPERTY = "Pod";

// Each audit record links to a page in the "Project Tracker" database, which
// is where the client's program ("Accelerate" vs "DFY") and assigned PO
// ("PO Name") actually live — the audit database itself doesn't store either
// directly. Fetched once per request and joined in by page ID below, so the
// Top Performers leaderboard can group posts by program and credit the
// right PO without the user having to duplicate that data into every audit
// record by hand.
const PROJECT_TRACKER_DATABASE_ID = "c16dfb55-fcd8-463b-af56-0eddfc0eb214";
const PROJECT_TRACKER_RELATION_PROPERTY = "📊 Project Tracker";

// Each audit record tracks up to 6 posts: "Top Post 1-3" and
// "Bottom Post 1-3", each with its own Format / Link / Title / Views.
const POST_SECTIONS = ["Top", "Bottom"];
const POST_SLOTS = 3;
const postPropertyNames = new Set();
for (const section of POST_SECTIONS) {
  for (let i = 1; i <= POST_SLOTS; i++) {
    postPropertyNames.add(`${section} Post ${i} Format`);
    postPropertyNames.add(`${section} Post ${i} Link`);
    postPropertyNames.add(`${section} Post ${i} Title`);
    postPropertyNames.add(`${section} Post ${i} Views`);
  }
}

function notionPageUrl(id) {
  return `https://www.notion.so/${String(id).replace(/-/g, "")}`;
}

// Pure UTC date-string math so results never depend on server/client
// timezone — Notion date properties are plain YYYY-MM-DD strings.
function toUTCDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function fromUTCDate(d) {
  return d.toISOString().slice(0, 10);
}
function addDays(dateStr, days) {
  const d = toUTCDate(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUTCDate(d);
}

function extractPosts(props) {
  const posts = [];
  for (const section of POST_SECTIONS) {
    for (let i = 1; i <= POST_SLOTS; i++) {
      const titleProp = props[`${section} Post ${i} Title`];
      const title = titleProp?.rich_text?.map((t) => t.plain_text).join("") || "";
      if (!title) continue;
      const linkProp = props[`${section} Post ${i} Link`];
      const formatProp = props[`${section} Post ${i} Format`];
      const viewsProp = props[`${section} Post ${i} Views`];
      posts.push({
        section,
        index: i,
        title,
        link: linkProp?.url || null,
        format: formatProp?.select?.name || null,
        views: typeof viewsProp?.number === "number" ? viewsProp.number : null,
      });
    }
  }
  return posts;
}

// Classifies every remaining (non-post, non-flag, non-week, non-title)
// property into short tags, long-form notes, or external links, based on
// its actual Notion property type.
function extractMeta(props) {
  const tags = [];
  const notes = [];
  const links = [];

  for (const key in props) {
    if (key === WEEK_PROPERTY || key === EXECUTION_PROPERTY || key === CREATIVE_PROPERTY) continue;
    if (postPropertyNames.has(key)) continue;
    const prop = props[key];
    if (!prop || prop.type === "title") continue;

    // Long values don't belong in a small tag chip — route them to notes
    // instead so they get proper labeled, wrappable display.
    const TAG_MAX_LEN = 40;
    function addValue(rawValue) {
      if (rawValue === null || rawValue === undefined || rawValue === "") return;
      const value = String(rawValue);
      if (value.length > TAG_MAX_LEN) notes.push({ label: key, value });
      else tags.push({ label: key, value });
    }

    switch (prop.type) {
      case "url":
        if (prop.url) links.push({ label: key, url: prop.url });
        break;
      case "relation":
        (prop.relation || []).forEach((r, idx) => {
          links.push({
            label: key + (prop.relation.length > 1 ? ` ${idx + 1}` : ""),
            url: notionPageUrl(r.id),
          });
        });
        break;
      case "rich_text": {
        const text = prop.rich_text.map((t) => t.plain_text).join("");
        if (text) notes.push({ label: key, value: text });
        break;
      }
      case "select":
        addValue(prop.select?.name);
        break;
      case "status":
        addValue(prop.status?.name);
        break;
      case "multi_select":
        addValue(prop.multi_select.length ? prop.multi_select.map((s) => s.name).join(", ") : null);
        break;
      case "checkbox":
        addValue(prop.checkbox ? "Yes" : "No");
        break;
      case "number":
        addValue(prop.number !== null && prop.number !== undefined ? prop.number.toLocaleString() : null);
        break;
      case "people":
        addValue(prop.people.length ? prop.people.map((p) => p.name || "Unknown").join(", ") : null);
        break;
      case "date":
        addValue(prop.date?.start || null);
        break;
      case "formula": {
        if (!prop.formula) break;
        let v = null;
        if (typeof prop.formula.string === "string") v = prop.formula.string;
        else if (typeof prop.formula.number === "number") v = prop.formula.number.toLocaleString();
        else if (typeof prop.formula.boolean === "boolean") v = prop.formula.boolean ? "Yes" : "No";
        addValue(v);
        break;
      }
      default:
        break;
    }
  }
  return { tags, notes, links };
}

// Best Post Title / Max Post Views are Notion formulas — their computed
// value lives under formula.string or formula.number depending on the
// formula's own return type. Pod is a plain select field on the audit
// record itself (no join needed).
function extractLeaderboardFields(props) {
  const bestPostTitle = props[BEST_POST_TITLE_PROPERTY]?.formula?.string || null;
  const maxViewsFormula = props[MAX_POST_VIEWS_PROPERTY]?.formula;
  const maxPostViews = typeof maxViewsFormula?.number === "number" ? maxViewsFormula.number : null;
  const pod = props[POD_PROPERTY]?.select?.name || null;
  return { bestPostTitle, maxPostViews, pod };
}

// Builds a map of Project Tracker page ID -> { category, po }. Wrapped so a
// failure here (e.g. the integration losing access to that database) never
// takes down the whole dashboard — audit records just fall back to no
// category/PO instead of a hard error.
async function fetchProjectTrackerMap(token) {
  const map = new Map();
  let cursor;
  for (;;) {
    const requestBody = { page_size: 100 };
    if (cursor) requestBody.start_cursor = cursor;

    const notionRes = await fetch(
      `https://api.notion.com/v1/databases/${PROJECT_TRACKER_DATABASE_ID}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      }
    );
    const body = await notionRes.json();
    if (!notionRes.ok) throw new Error(body?.message || "Project Tracker query failed");

    for (const page of body.results) {
      const props = page.properties;
      map.set(page.id, {
        category: props["Project Type"]?.select?.name || null,
        po: props["PO Name"]?.select?.name || null,
      });
    }
    if (body.has_more && body.next_cursor) cursor = body.next_cursor;
    else break;
  }
  return map;
}

export default async function handler(req, res) {
  // No caching — this dashboard needs to reflect Notion edits immediately
  // (the whole point of the refresh button), so every request hits Notion
  // live rather than serving a stale response from Vercel's edge cache.
  res.setHeader("Cache-Control", "no-store, max-age=0");

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    return res.status(500).json({
      error: "NOTION_TOKEN is not set in this deployment's environment variables.",
    });
  }

  try {
    // Resolve Accelerate/DFY + PO info before pulling audit records. If it
    // fails, we log and continue with an empty map — every record just gets
    // category/po: null rather than the whole dashboard breaking.
    let projectTrackerMap = new Map();
    let projectTrackerError = null;
    try {
      projectTrackerMap = await fetchProjectTrackerMap(token);
    } catch (trackerErr) {
      projectTrackerError = trackerErr.message;
      console.error("Project Tracker lookup failed:", trackerErr.message);
    }

    // Two more granular counters so the frontend can tell apart the three
    // distinct ways this join can come up empty, instead of guessing:
    //   1. recordsWithTrackerRelation — how many audit records actually have
    //      the "📊 Project Tracker" relation filled in at all. If this is 0,
    //      it's a Notion data-entry gap on the audit records themselves, not
    //      a permissions problem.
    //   2. recordsWithResolvedCategory — of those, how many successfully
    //      matched a Project Tracker page in projectTrackerMap with a
    //      Project Type set. If recordsWithTrackerRelation > 0 but this is
    //      0, the relation is filled in but the join/lookup itself is
    //      failing (wrong database ID, stale deploy, or the linked Project
    //      Tracker pages are missing "Project Type").
    let recordsWithTrackerRelation = 0;
    let recordsWithResolvedCategory = 0;

    // Notion caps each query response at 100 rows, so we page through
    // start_cursor/has_more until every record has been fetched. Without
    // this, only the most recent ~100 rows would ever be visible, which
    // silently caps how many weeks of history the dashboard can show.
    let allResults = [];
    let cursor = undefined;
    for (;;) {
      const requestBody = {
        sorts: [{ property: WEEK_PROPERTY, direction: "descending" }],
        page_size: 100,
      };
      if (cursor) requestBody.start_cursor = cursor;

      const notionRes = await fetch(
        `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        }
      );

      const notionBody = await notionRes.json();

      if (!notionRes.ok) {
        return res.status(notionRes.status).json({
          error: "Notion API request failed",
          status: notionRes.status,
          notion_error: notionBody,
        });
      }

      allResults = allResults.concat(notionBody.results);
      if (notionBody.has_more && notionBody.next_cursor) {
        cursor = notionBody.next_cursor;
      } else {
        break;
      }
    }

    // Group strictly by the literal "Week Of" start date stored in Notion.
    // An earlier version tried to be "smart" and snap nearby dates together
    // to fix a display glitch, but that actually pulled records in from
    // adjacent weeks and inflated flag counts — verified by hand-checking
    // real records against the dashboard's numbers. Trusting the exact
    // stored date is the only way to keep counts accurate; if a specific
    // record's date is wrong, that's a data entry fix in Notion itself.
    const weekMap = new Map();
    for (const page of allResults) {
      const props = page.properties;
      const weekStart = props[WEEK_PROPERTY]?.date?.start;
      if (!weekStart) continue;

      if (!weekMap.has(weekStart)) {
        weekMap.set(weekStart, {
          end: addDays(weekStart, 6),
          execution: 0,
          creative: 0,
          total: 0,
          records: [],
        });
      }
      const bucket = weekMap.get(weekStart);
      bucket.total += 1;

      const executionFlag = !!props[EXECUTION_PROPERTY]?.checkbox;
      const creativeFlag = !!props[CREATIVE_PROPERTY]?.checkbox;
      if (executionFlag) bucket.execution += 1;
      if (creativeFlag) bucket.creative += 1;

      let title = "Untitled";
      for (const key in props) {
        if (props[key].type === "title") {
          const text = props[key].title.map((t) => t.plain_text).join("");
          if (text) title = text;
          break;
        }
      }

      const posts = extractPosts(props);
      const { tags, notes, links } = extractMeta(props);

      const trackerId = props[PROJECT_TRACKER_RELATION_PROPERTY]?.relation?.[0]?.id || null;
      if (trackerId) recordsWithTrackerRelation += 1;
      const trackerInfo = trackerId ? projectTrackerMap.get(trackerId) : null;
      const category = trackerInfo?.category || null; // "Accelerate" | "DFY" | null
      const po = trackerInfo?.po || null;
      if (category) recordsWithResolvedCategory += 1;

      const { bestPostTitle, maxPostViews, pod } = extractLeaderboardFields(props);

      bucket.records.push({
        title,
        executionFlag,
        creativeFlag,
        posts,
        tags,
        notes,
        links,
        category,
        po,
        bestPostTitle,
        maxPostViews,
        pod,
      });
    }

    // Every distinct week found, oldest → newest for chart display. This
    // grows automatically as new weeks are added to the database — no
    // fixed cap.
    const weeks = [...weekMap.keys()].sort();

    return res.status(200).json({
      weeks,
      weekEnds: weeks.map((w) => weekMap.get(w).end),
      executionFlags: weeks.map((w) => weekMap.get(w).execution),
      creativeFlags: weeks.map((w) => weekMap.get(w).creative),
      totalRecords: weeks.map((w) => weekMap.get(w).total),
      recordsByWeek: weeks.map((w) => weekMap.get(w).records),
      // Diagnostics for the Top Performers tab — lets the frontend pinpoint
      // exactly which stage of the Project Tracker join is failing instead
      // of showing one generic "no data" message. See the comments above
      // recordsWithTrackerRelation / recordsWithResolvedCategory for what
      // each combination means.
      projectTrackerLinkedCount: projectTrackerMap.size,
      projectTrackerError,
      recordsWithTrackerRelation,
      recordsWithResolvedCategory,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Unexpected error while fetching Notion data",
      message: err.message,
    });
  }
}
