
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../../data/working_memory.json');

function load() {
  if (!fs.existsSync(DATA_FILE)) {
    return {
      active_questions: [],
      active_threads: [],
      active_tensions: []
    };
  }
  return JSON.parse(fs.readFileSync(DATA_FILE));
}

function save(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

exports.handler = async (event) => {
  const memory = load();
  const body = event.body ? JSON.parse(event.body) : {};

  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      body: JSON.stringify(memory)
    };
  }

  if (event.httpMethod === "POST") {
    const { bucket, item } = body;
    if (!memory[bucket]) memory[bucket] = [];
    memory[bucket].push(item);
    save(memory);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true })
    };
  }
};
