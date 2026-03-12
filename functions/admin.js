exports.handler = async (event) => {
  const secret = event.headers["x-admin-secret"] || (event.body ? (() => { try { return JSON.parse(event.body).secret; } catch { return null; } })() : null);
  if (!process.env.MIKE_SECRET || secret !== process.env.MIKE_SECRET) {
    return {
      statusCode: 403,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Unauthorized" })
    };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({ ok: true, admin: true })
  };
};