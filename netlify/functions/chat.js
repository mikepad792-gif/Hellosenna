
exports.handler = async (event) => {

  const body = JSON.parse(event.body);
  const userMessage = body.message;

  const response = {
    reply: "Senna received: " + userMessage,
    note: "Retrieval + reflection systems will plug in here."
  };

  return {
    statusCode: 200,
    body: JSON.stringify(response)
  };
};
