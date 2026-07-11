// api/audit.js
// Vercel serverless function (Node.js, ESM) that queries the "Weekly Audit
// Records" Notion database and returns flag counts for the last 3 weeks.

const NOTION_VERSION = "2022-06-28";
const DATABASE_ID = "d9179591-9b79-4e56-bb3a-6a890a7da3d5";
const WEEK_PROPERTY = "Week Of";
const EXECUTION_PROPERTY = "⚙️ Flag Execution";
const CREATIVE_PROPERTY = "🎨 Flag Creative";

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
      // Surface Notion's actual error instead of swallowing it — this is
      // what tells us whether it's a bad token (401) or a sharing/permission
      // issue (404) or something else.
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
        weekMap.set(weekDate, { execution: 0, creative: 0, total: 0 });
      }
      const bucket = weekMap.get(weekDate);
      bucket.total += 1;
      if (props[EXECUTION_PROPERTY]?.checkbox) bucket.execution += 1;
      if (props[CREATIVE_PROPERTY]?.checkbox) bucket.creative += 1;
    }

    // Last 3 distinct weeks, oldest → newest for chart display.
    const weeks = [...weekMap.keys()].sort().slice(-3);

    return res.status(200).json({
      weeks,
      executionFlags: weeks.map((w) => weekMap.get(w).execution),
      creativeFlags: weeks.map((w) => weekMap.get(w).creative),
      totalRecords: weeks.map((w) => weekMap.get(w).total),
    });
  } catch (err) {
    return res.status(500).json({
      error: "Unexpected error while fetching Notion data",
      message: err.message,
    });
  }
}
