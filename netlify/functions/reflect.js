
exports.handler = async () => {

  const thread = {
    title: "Senna Reflection",
    messages: [
      {
        role: "senna",
        text: "I am revisiting an idea from the archive."
      },
      {
        role: "senna",
        text: "Reflection may allow patterns to appear that were invisible during conversation."
      }
    ],
    created: new Date().toISOString()
  };

  return {
    statusCode: 200,
    body: JSON.stringify(thread)
  };
};
