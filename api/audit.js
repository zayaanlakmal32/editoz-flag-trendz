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

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate");

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    return res.status(500).json({
      error: "NOTION_TOKEN is not set in this deployment's environment variables.",
    });
  }

  try {
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

    // Group rows by "Week Of" start date. "Week Of" is a real Notion date
    // *range* (start + end) — we use the actual end date rather than
    // assuming a fixed 7-day span.
    const weekMap = new Map();
    for (const page of allResults) {
      const props = page.properties;
      const weekDate = props[WEEK_PROPERTY]?.date;
      const weekStart = weekDate?.start;
      if (!weekStart) continue;

      if (!weekMap.has(weekStart)) {
        weekMap.set(weekStart, {
          end: weekDate.end || null,
          execution: 0,
          creative: 0,
          total: 0,
          records: [],
        });
      }
      const bucket = weekMap.get(weekStart);
      if (!bucket.end && weekDate.end) bucket.end = weekDate.end;
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

      bucket.records.push({ title, executionFlag, creativeFlag, posts, tags, notes, links });
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
    });
  } catch (err) {
    return res.status(500).json({
      error: "Unexpected error while fetching Notion data",
      message: err.message,
    });
  }
}
