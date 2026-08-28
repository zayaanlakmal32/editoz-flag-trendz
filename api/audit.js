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

// Notion property names sometimes carry an emoji prefix. Match by words so
// "Goal Achieved", "🎯 Goal Achieved", etc. all work without a deploy.
const GOAL_ACHIEVED_PROPERTY_PATTERN = /goal\s*achiev(?:ed|ement)?/i;

function extractGoalAchieved(props) {
  for (const [name, prop] of Object.entries(props)) {
    if (!GOAL_ACHIEVED_PROPERTY_PATTERN.test(name) || !prop) continue;
    if (prop.type === "checkbox") return prop.checkbox;
    if (prop.type === "number") return prop.number;
    if (prop.type === "select") return prop.select?.name || null;
    if (prop.type === "status") return prop.status?.name || null;
    if (prop.type === "formula") {
      const formula = prop.formula;
      if (typeof formula?.number === "number") return formula.number;
      if (typeof formula?.boolean === "boolean") return formula.boolean;
      if (typeof formula?.string === "string") return formula.string;
    }
    if (prop.type === "rollup") {
      const rollup = prop.rollup;
      if (typeof rollup?.number === "number") return rollup.number;
    }
    return null;
  }
  return null;
}

function propertyNumber(prop) {
  if (!prop) return null;
  if (prop.type === "number" && typeof prop.number === "number") return prop.number;
  if (prop.type === "formula" && typeof prop.formula?.number === "number") return prop.formula.number;
  if (prop.type === "rollup" && typeof prop.rollup?.number === "number") return prop.rollup.number;
  return null;
}

function propertyText(prop) {
  if (!prop) return null;
  if (prop.type === "select") return prop.select?.name || null;
  if (prop.type === "status") return prop.status?.name || null;
  if (prop.type === "multi_select") return prop.multi_select?.map((item) => item.name).join(", ") || null;
  if (prop.type === "formula" && typeof prop.formula?.string === "string") return prop.formula.string;
  if (prop.type === "rich_text") return prop.rich_text?.map((t) => t.plain_text).join("") || null;
  return null;
}

function inferGoalUnit(text) {
  const value = String(text || "").toLowerCase();
  if (/\b(?:ops?|operations?)\b/.test(value)) return "ops";
  if (/\bleads?\b/.test(value)) return "leads";
  if (/\bviews?\b/.test(value)) return "views";
  if (/\bfollowers?\b/.test(value)) return "followers";
  if (/\bsubscribers?\b/.test(value)) return "subscribers";
  if (/\b(?:call\s*)?bookings?\b/.test(value)) return "bookings";
  return null;
}

// Goal setups differ by client (ops, leads, views, followers, bookings).
// Prefer a direct numeric Goal Progress/% formula. Otherwise pair structured
// target + actual fields, including M1/M2/M3 Actual totals for 90-day goals.
function extractGoalProgress(props, source = "project_tracker") {
  const numeric = Object.entries(props).map(([name, prop]) => ({
    name,
    lower: name.toLowerCase(),
    value: propertyNumber(prop),
  })).filter((field) => typeof field.value === "number");
  const goalTypeEntry = Object.entries(props).find(([name]) => /goal.*(?:type|metric|category)|(?:type|metric|category).*goal/i.test(name));
  const goalType = goalTypeEntry ? propertyText(goalTypeEntry[1]) : null;
  const goalUnit = inferGoalUnit(goalType);

  const directPercent = numeric.find((field) =>
    /goal/.test(field.lower) && /(progress|percent|percentage|%)/.test(field.lower) &&
    !/(target|actual|delivered)/.test(field.lower)
  );
  const opTarget = (!goalUnit || goalUnit === "ops") ? numeric.find((field) =>
    field.value > 0 && /\bops?\b.*\btarget\b|\btarget\b.*\bops?\b/.test(field.lower)
  ) : null;
  const ninetyDayTarget = numeric.find((field) =>
    field.value > 0 && /90[-\s]*(?:day|days|d).*\b(?:goal|target)\b|\b(?:goal|target)\b.*90[-\s]*(?:day|days|d)/.test(field.lower) &&
    (!goalUnit || !inferGoalUnit(field.name) || inferGoalUnit(field.name) === goalUnit)
  );
  const namedGoalTarget = numeric.find((field) =>
    field.value > 0 && /\bgoal\b.*\btarget\b|\btarget\b.*\bgoal\b/.test(field.lower) &&
    !/(progress|percent|percentage)/.test(field.lower) &&
    (!goalUnit || !inferGoalUnit(field.name) || inferGoalUnit(field.name) === goalUnit)
  );
  const genericTarget = numeric.find((field) =>
    field.value > 0 && /\btarget\b/.test(field.lower) &&
    !/(date|day|days|left|actual|delivered|progress|percent|percentage)/.test(field.lower) &&
    (!goalUnit || !inferGoalUnit(field.name) || inferGoalUnit(field.name) === goalUnit)
  );
  const targetField = opTarget || ninetyDayTarget || namedGoalTarget || genericTarget || null;
  const targetUnit = inferGoalUnit([goalType, targetField?.name].filter(Boolean).join(" "));

  let actualFields = [];
  if (opTarget) {
    const opActual = numeric.find((field) =>
      /\bops?\b.*\b(?:delivered|actual)\b|\b(?:delivered|actual)\b.*\bops?\b/.test(field.lower)
    );
    if (opActual) actualFields = [opActual];
  }
  if (!actualFields.length && (ninetyDayTarget || namedGoalTarget)) {
    const monthlyActuals = numeric.filter((field) =>
      /\b(?:m|month)\s*[123]\b.*\bactual\b|\bactual\b.*\b(?:m|month)\s*[123]\b/.test(field.lower)
    );
    if (monthlyActuals.length) actualFields = monthlyActuals;
  }
  if (!actualFields.length) {
    const actualCandidates = numeric.filter((field) =>
      /\b(?:goal|total)\b.*\b(?:actual|delivered|current)\b|\b(?:actual|delivered|current)\b.*\b(?:goal|total)\b/.test(field.lower)
    ).concat(numeric.filter((field) =>
      /\b(?:actual|delivered)\b/.test(field.lower) && !/(date|day|days|target)/.test(field.lower)
    ));
    const actual = actualCandidates.find((field) => {
      const unit = inferGoalUnit(field.name);
      return !targetUnit || !unit || unit === targetUnit;
    });
    if (actual) actualFields = [actual];
  }

  let actual = actualFields.length ? actualFields.reduce((sum, field) => sum + field.value, 0) : null;
  let target = targetField?.value ?? null;
  const directPercentValue = directPercent
    ? (directPercent.value >= 0 && directPercent.value <= 1 ? directPercent.value * 100 : directPercent.value)
    : null;
  let percent = directPercentValue ?? (actual !== null && target > 0 ? (actual / target) * 100 : null);

  // A direct progress formula is authoritative. Drop a nearby actual/target
  // pair if its ratio proves those fields describe a different metric.
  if (directPercent && actual !== null && target > 0 && Math.abs((actual / target) * 100 - percent) > 1) {
    actual = null;
    target = null;
    actualFields = [];
  }
  if (percent === null && actual === null && target === null) return null;

  const sourceNames = [target !== null ? targetField?.name : null, ...actualFields.map((field) => field.name), directPercent?.name].filter(Boolean);
  const unit = inferGoalUnit([goalType, ...sourceNames].join(" "));
  return {
    actual,
    target,
    percent,
    unit,
    label: goalType || unit || "Goal progress",
    source,
    sourceFields: sourceNames,
  };
}

function parseCompactNumber(value) {
  const match = String(value || "").trim().match(/^([\d,.]+)\s*([km])?$/i);
  if (!match) return null;
  const number = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(number)) return null;
  return number * (match[2]?.toLowerCase() === "k" ? 1e3 : match[2]?.toLowerCase() === "m" ? 1e6 : 1);
}

function goalPercentFromClause(text) {
  const clauses = String(text || "").split(/[.!?\n]+/);
  for (const clause of clauses) {
    const unit = inferGoalUnit(clause);
    if (!unit || !/\b(?:goal|target)\b/i.test(clause)) continue;
    const match = clause.match(/(\d+(?:\.\d+)?)\s*%\s*(?:delivered|complete|achieved)/i);
    if (match) return { percent: Number(match[1]), unit };
  }
  return null;
}

// Older tracker rows do not always expose structured actual/target fields.
// Audit Notes already contain audited goal facts; parse only goal-specific
// phrases as a fallback (never arbitrary numbers from the note).
function inferGoalProgressFromNotes(notes) {
  const text = (notes || []).map((note) => note.value || "").join(" ");
  if (!text) return null;
  const unitPattern = "(ops?|operations?|leads?|accumulated[-\\s]+views?|views?|followers?|subscribers?|(?:call\\s*)?bookings?)";
  let match = text.match(new RegExp("([\\d,.]+[km]?)\\s*\\/\\s*([\\d,.]+[km]?)\\s*" + unitPattern, "i"));
  if (!match) {
    match = text.match(new RegExp("([\\d,.]+[km]?)\\s+of\\s+(?:the\\s+)?([\\d,.]+[km]?)\\s+" + unitPattern, "i"));
  }
  if (match) {
    const actual = parseCompactNumber(match[1]);
    const target = parseCompactNumber(match[2]);
    if (actual !== null && target > 0) {
      const unit = inferGoalUnit(match[3]);
      return { actual, target, percent: (actual / target) * 100, unit, label: unit || "Goal progress", source: "audit_notes", sourceFields: [] };
    }
  }

  match = text.match(new RegExp("([\\d,.]+[km]?)\\s+" + unitPattern + "\\s+(?:delivered|logged)\\s+against\\s+(?:the\\s+)?([\\d,.]+[km]?)\\s+(?:90[- ]day\\s+)?(?:goal|target)", "i"));
  if (match) {
    const actual = parseCompactNumber(match[1]);
    const target = parseCompactNumber(match[3]);
    if (actual !== null && target > 0) {
      const unit = inferGoalUnit(match[2]);
      return { actual, target, percent: (actual / target) * 100, unit, label: unit || "Goal progress", source: "audit_notes", sourceFields: [] };
    }
  }

  match = text.match(new RegExp("(\\d+(?:\\.\\d+)?)%\\s+of\\s+(?:the\\s+)?([\\d,.]+[km]?)\\s*[- ]?" + unitPattern + "\\s+goal", "i"));
  if (match) {
    const target = parseCompactNumber(match[2]);
    const unit = inferGoalUnit(match[3]);
    if (target > 0) {
      return { actual: null, target, percent: Number(match[1]), unit, label: unit || "Goal progress", source: "audit_notes", sourceFields: [] };
    }
  }

  match = text.match(new RegExp("(\\d+(?:\\.\\d+)?)%\\s+delivered\\s+against\\s+(?:the\\s+)?([\\d,.]+[km]?)\\s*(?:hot[-\\s]+)?" + unitPattern + "\\s+target", "i"));
  if (match) {
    const target = parseCompactNumber(match[2]);
    const unit = inferGoalUnit(match[3]);
    if (target > 0) {
      return { actual: null, target, percent: Number(match[1]), unit, label: unit || "Goal progress", source: "audit_notes", sourceFields: [] };
    }
  }

  let targetMatch = text.match(new RegExp(unitPattern + "\\s+(?:goal|target)\\s+(?:of\\s+)?\\(?([\\d,.]+[km]?)", "i"));
  if (!targetMatch) {
    targetMatch = text.match(new RegExp("(?:goal|target)\\s+of\\s+([\\d,.]+[km]?)\\s+" + unitPattern, "i"));
    if (targetMatch) targetMatch = [targetMatch[0], targetMatch[2], targetMatch[1]];
  }
  if (targetMatch) {
    const unit = inferGoalUnit(targetMatch[1]);
    const target = parseCompactNumber(targetMatch[2]);
    let actualMatch = text.match(/(?:m[123]\s+)?actual\s+(?:sits\s+at|is|:)?\s*([\d,.]+[km]?)/i);
    if (!actualMatch) {
      const loggedMatch = text.match(new RegExp("(?:only\\s+)?([\\d,.]+[km]?)\\s+" + unitPattern + "\\s+(?:delivered|logged)", "i"));
      if (loggedMatch && inferGoalUnit(loggedMatch[2]) === unit) actualMatch = [loggedMatch[0], loggedMatch[1]];
    }
    const actual = actualMatch ? parseCompactNumber(actualMatch[1]) : null;
    const clauseProgress = goalPercentFromClause(text);
    const percent = actual !== null && target > 0 ? (actual / target) * 100 : clauseProgress?.percent ?? null;
    if (target > 0 && (actual !== null || percent !== null)) {
      return { actual, target, percent, unit, label: unit || "Goal progress", source: "audit_notes", sourceFields: [] };
    }
  }

  const clauseProgress = goalPercentFromClause(text);
  if (clauseProgress) {
    return { actual: null, target: null, percent: clauseProgress.percent, unit: clauseProgress.unit, label: clauseProgress.unit, source: "audit_notes", sourceFields: [] };
  }
  if (/goal\s+(?:is\s+)?already\s+(?:achieved|exceeded)|goal\s+already\s+achieved/i.test(text)) {
    return { actual: null, target: null, percent: 100, unit: inferGoalUnit(text), label: inferGoalUnit(text) || "Goal progress", source: "audit_notes", sourceFields: [] };
  }
  return null;
}

function mergeGoalProgress(primary, fallback) {
  if (!primary) return fallback || null;
  if (!fallback) return primary;

  const hasPercent = (progress) =>
    typeof progress?.percent === "number" && Number.isFinite(progress.percent);
  const selected = hasPercent(primary) ? primary : hasPercent(fallback) ? fallback : primary;
  const other = selected === primary ? fallback : primary;

  // Keep each snapshot atomic. Only borrow actual/target from the other
  // source when its computed percentage confirms it describes the same
  // snapshot; otherwise the displayed fraction could contradict the bar.
  if (
    hasPercent(selected) &&
    (selected.actual === null || selected.target === null) &&
    typeof other.actual === "number" &&
    typeof other.target === "number" &&
    other.target > 0
  ) {
    const candidate = {
      ...selected,
      actual: selected.actual ?? other.actual,
      target: selected.target ?? other.target,
      unit: selected.unit || other.unit,
      label: selected.label || other.label,
    };
    const candidatePercent = (candidate.actual / candidate.target) * 100;
    if (candidate.target > 0 && Math.abs(candidatePercent - selected.percent) <= 1) {
      return {
        ...candidate,
      };
    }
  }

  return selected;
}

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
  const goalAchieved = extractGoalAchieved(props);
  const goalProgress = extractGoalProgress(props, "audit_record");
  return { bestPostTitle, maxPostViews, goalAchieved, goalProgress, pod };
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
        goalAchieved: extractGoalAchieved(props),
        goalProgress: extractGoalProgress(props),
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
    const allWeekStarts = allResults
      .map((page) => page.properties[WEEK_PROPERTY]?.date?.start)
      .filter(Boolean)
      .sort();
    const latestWeekStart = allWeekStarts[allWeekStarts.length - 1] || null;
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

      const {
        bestPostTitle,
        maxPostViews,
        goalAchieved: auditGoalAchieved,
        goalProgress: auditGoalProgress,
        pod,
      } = extractLeaderboardFields(props);
      // Project Tracker holds the client's current values, not historical
      // snapshots. Use it only for the newest audit week so old trends stay
      // anchored to the audit record and its contemporaneous notes.
      const currentTrackerInfo = weekStart === latestWeekStart ? trackerInfo : null;
      const goalAchieved = auditGoalAchieved ?? currentTrackerInfo?.goalAchieved ?? null;
      const structuredGoalProgress = mergeGoalProgress(auditGoalProgress, currentTrackerInfo?.goalProgress);
      const goalProgress = mergeGoalProgress(structuredGoalProgress, inferGoalProgressFromNotes(notes));

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
        goalAchieved,
        goalProgress,
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
