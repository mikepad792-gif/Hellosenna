
exports.handler = async (event) => {
  const secret = process.env.MIKE_SECRET;
  const provided = event.headers["x-admin-secret"] || event.headers["X-Admin-Secret"];
  if (!secret || provided !== secret) {
    return { statusCode: 403, body: "forbidden" };
  }
  return { statusCode: 200, body: "admin ok" };
};
