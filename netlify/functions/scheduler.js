exports.handler = async () => {
  try {
    const baseUrl = process.env.URL || (process.env.DEPLOY_URL ? `https://${process.env.DEPLOY_URL}` : null);
    if (!baseUrl) {
      return { statusCode: 500, body: "Missing URL/DEPLOY_URL" };
    }

    const res = await fetch(`${baseUrl}/.netlify/functions/reflect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-secret": process.env.MIKE_SECRET || ""
      },
      body: JSON.stringify({ secret: process.env.MIKE_SECRET || "" })
    });

    const text = await res.text();
    return {
      statusCode: res.status,
      headers: { "Content-Type": "application/json" },
      body: text
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: error?.message || "scheduler error" })
    };
  }
};