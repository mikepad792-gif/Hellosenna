exports.handler = async () => {
  return {
    statusCode: 501,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({
      ok: false,
      message: "Direct upload endpoint is not used in Senna v1.1. Files are attached client-side and sent through chat."
    })
  };
};