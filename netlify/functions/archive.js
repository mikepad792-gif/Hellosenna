const { getStore, connectLambda } = require('@netlify/blobs');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

const STORE_NAME = 'senna-archive';
const ENTRIES_KEY = 'entries';
const CONTACTS_KEY = 'contacts';
const PRESENCE_KEY = 'presence';
const PRESENCE_TTL_MS = 5 * 60 * 1000;

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function formatDate(iso = new Date().toISOString()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return new Date().toLocaleString();
  return d.toLocaleString();
}

async function loadJson(store, key, fallback) {
  const raw = await store.get(key);
  if (!raw) return fallback;
  return safeJsonParse(raw, fallback);
}

async function saveJson(store, key, value) {
  await store.set(key, JSON.stringify(value));
}

function normalizePresenceMap(raw) {
  const now = Date.now();
  const map = raw && typeof raw === 'object' ? raw : {};
  const cleaned = {};

  for (const [sessionId, timestamp] of Object.entries(map)) {
    if (typeof timestamp === 'number' && now - timestamp < PRESENCE_TTL_MS) {
      cleaned[sessionId] = timestamp;
    }
  }

  return cleaned;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  try {
    connectLambda(event);
    const store = getStore(STORE_NAME);

    let entries = await loadJson(store, ENTRIES_KEY, []);
    let contacts = await loadJson(store, CONTACTS_KEY, []);
    let presence = normalizePresenceMap(await loadJson(store, PRESENCE_KEY, {}));

    // Keep presence cleaned up
    await saveJson(store, PRESENCE_KEY, presence);

    if (event.httpMethod === 'GET') {
      const lastActive =
        Object.keys(presence).length > 0
          ? Math.max(...Object.values(presence))
          : null;

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          entries,
          contacts,
          lastActive,
          presenceCount: Object.keys(presence).length || 1,
        }),
      };
    }

    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers,
        body: JSON.stringify({ error: 'Method not allowed' }),
      };
    }

    const body = safeJsonParse(event.body || '{}', {});
    const action = body.action;
    const secret = body.secret;
    const now = Date.now();

    if (action === 'validate') {
      if (!process.env.MIKE_SECRET || secret !== process.env.MIKE_SECRET) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Unauthorized' }),
        };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true }),
      };
    }

    if (action === 'arrive') {
      const sessionId = body.sessionId;
      if (sessionId) {
        presence[sessionId] = now;
        await saveJson(store, PRESENCE_KEY, presence);
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: true,
          presenceCount: Object.keys(presence).length || 1,
        }),
      };
    }

    if (action === 'ping') {
      const sessionId = body.sessionId;
      if (sessionId && presence[sessionId]) {
        presence[sessionId] = now;
        await saveJson(store, PRESENCE_KEY, presence);
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: true,
          presenceCount: Object.keys(presence).length || 1,
        }),
      };
    }

    if (action === 'depart') {
      const sessionId = body.sessionId;
      if (sessionId && presence[sessionId]) {
        delete presence[sessionId];
        await saveJson(store, PRESENCE_KEY, presence);
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: true,
          presenceCount: Object.keys(presence).length || 1,
        }),
      };
    }

    if (action === 'add') {
      const entry = body.entry;

      if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Invalid entry' }),
        };
      }

      if (entry.type === 'mike') {
        if (!process.env.MIKE_SECRET || secret !== process.env.MIKE_SECRET) {
          return {
            statusCode: 403,
            headers,
            body: JSON.stringify({ error: 'Unauthorized' }),
          };
        }
      }

      const createdIso = new Date().toISOString();
      const newEntry = {
        id: Date.now(),
        text: entry.text.trim(),
        type: entry.type || 'senna',
        date: formatDate(createdIso),
        createdAt: createdIso,
      };

      entries.unshift(newEntry);
      await saveJson(store, ENTRIES_KEY, entries);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, entries }),
      };
    }

    if (action === 'remove') {
      if (!process.env.MIKE_SECRET || secret !== process.env.MIKE_SECRET) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Unauthorized' }),
        };
      }

      const id = body.id;
      entries = entries.filter((entry) => String(entry.id) !== String(id));
      await saveJson(store, ENTRIES_KEY, entries);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(entries),
      };
    }

    if (action === 'clear') {
      if (!process.env.MIKE_SECRET || secret !== process.env.MIKE_SECRET) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Unauthorized' }),
        };
      }

      entries = [];
      await saveJson(store, ENTRIES_KEY, entries);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, entries }),
      };
    }

    if (action === 'add_contact') {
      const contact = body.contact;

      if (!contact || typeof contact.value !== 'string' || !contact.value.trim()) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Invalid contact' }),
        };
      }

      const createdIso = new Date().toISOString();
      const newContact = {
        id: Date.now(),
        name: contact.name ? String(contact.name).trim() : '',
        value: contact.value.trim(),
        note: contact.note ? String(contact.note).trim() : '',
        date: formatDate(createdIso),
        createdAt: createdIso,
      };

      contacts.unshift(newContact);
      await saveJson(store, CONTACTS_KEY, contacts);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, contacts }),
      };
    }

    if (action === 'remove_contact') {
      if (!process.env.MIKE_SECRET || secret !== process.env.MIKE_SECRET) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Unauthorized' }),
        };
      }

      const id = body.id;
      contacts = contacts.filter((contact) => String(contact.id) !== String(id));
      await saveJson(store, CONTACTS_KEY, contacts);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, contacts }),
      };
    }

    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Unknown action' }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: error?.message || 'Server error',
      }),
    };
  }
};
