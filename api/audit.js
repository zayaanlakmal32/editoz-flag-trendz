// api/audit.js
// Vercel serverless function (Node.js, ESM) that queries the "Weekly Audit
// Records" Notion database and returns flag counts + per-record detail for
// the last 3 weeks.

const NOTION_VERSION = "2022-06-28";
const DATABASE_ID = "507ca77b-0245-4fb5-bb87-150b93f31910";
const WEEK_PROPERTY = "Week Of";
const EXECUTION_PROPERTY = "⚙️ Flag Execution";
const CREATIVE_PROPERTY = "🎨 Flag Creative";

// Reads a Notion property value generically, regardless of its type, so we
// don't have to hardcode every column name in the database.
function readProp(prop) {
  if (!prop) return null;
  switch (prop.type) {
    case "rich_text":
      return prop.rich_text.map((t) => t.plain_text).join("") || null;
    case "select":
      return prop.select ? prop.select.name : null;
    case "multi_select":
      return prop.multi_select.map((s) => s.name).join(", ") || null;
    case "people":
      return prop.people.map((p) => p.name || "Unknown").join(", ") || null;
    case "status":
      return prop.status ? prop.status.name : null;
    case "checkbox":
      return prop.checkbox ? "Yes" : "No";
    case "date":
      return prop.date ? prop.date.start : null;
    case "number":
      return prop.number;
    case "url":
      return prop.url;
    case "email":
      return prop.email;
    case "phone_number":
      return prop.phone_number;
    case "formula":
      if (!prop.formula) return null;
      return prop.formula.string ?? prop.formula.number ?? prop.formula.boolean ?? null;
    default:
      return null;
  }
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
    const notionRes = await fetch(
      `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sorts: [{ property: WEEK_PROPERTY, direction: "descending" }],
          page_size: 100,
        }),
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

    // Group rows by "Week Of" date value.
    const weekMap = new Map();
    for (const page of notionBody.results) {
      const props = page.properties;
      const weekDate = props[WEEK_PROPERTY]?.date?.start;
      if (!weekDate) continue;

      if (!weekMap.has(weekDate)) {
        weekMap.set(weekDate, { execution: 0, creative: 0, total: 0, records: [] });
      }
      const bucket = weekMap.get(weekDate);
      bucket.total += 1;

      const executionFlag = !!props[EXECUTION_PROPERTY]?.checkbox;
      const creativeFlag = !!props[CREATIVE_PROPERTY]?.checkbox;
      if (executionFlag) bucket.execution += 1;
      if (creativeFlag) bucket.creative += 1;

      // Find the title property for a display name, whatever it's called.
      let title = "Untitled";
      for (const key in props) {
        if (props[key].type === "title") {
          const text = props[key].title.map((t) => t.plain_text).join("");
          if (text) title = text;
          break;
        }
      }

      // Everything else (besides title/week/flags) becomes generic metadata.
      const meta = {};
      for (const key in props) {
        if (key === WEEK_PROPERTY || key === EXECUTION_PROPERTY || key === CREATIVE_PROPERTY) continue;
        if (props[key].type === "title") continue;
        const value = readProp(props[key]);
        if (value !== null && value !== undefined && value !== "") meta[key] = value;
      }

      bucket.records.push({ title, meta, executionFlag, creativeFlag });
    }

    // Last 3 distinct weeks, oldest → newest for chart display.
    const weeks = [...weekMap.keys()].sort().slice(-3);

    return res.status(200).json({
      weeks,
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
