
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../../data/archives.json');

function load() {
  if (!fs.existsSync(DATA_FILE)) return { archives: {} };
  return JSON.parse(fs.readFileSync(DATA_FILE));
}

function save(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

exports.handler = async (event) => {
  const data = load();
  const params = event.queryStringParameters || {};
  const body = event.body ? JSON.parse(event.body) : {};

  if (event.httpMethod === "GET") {
    if (params.archive) {
      return {
        statusCode: 200,
        body: JSON.stringify(data.archives[params.archive] || [])
      };
    }
    return {
      statusCode: 200,
      body: JSON.stringify(data.archives)
    };
  }

  if (event.httpMethod === "POST") {
    const { archive, entry } = body;
    if (!data.archives[archive]) data.archives[archive] = [];
    data.archives[archive].push(entry);
    save(data);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true })
    };
  }
};
