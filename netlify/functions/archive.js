const { getStore } = require('@netlify/blobs');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

const PRESENCE_TTL_MS = 5 * 60 * 1000; // 5 min — session considered gone if no ping

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  const store = getStore('senna-archive');

  // ── GET — entries + lastActive + presence count ─────────────────────────
  if (event.httpMethod === 'GET') {
    try {
      const [entries, lastActive, sessions, contacts] = await Promise.all([
        store.get('entries',   { type: 'json' }).catch(() => []),
        store.get('lastActive',{ type: 'json' }).catch(() => null),
        store.get('sessions',  { type: 'json' }).catch(() => ({})),
        store.get('contacts',  { type: 'json' }).catch(() => []),
      ]);

      // Count active sessions (pinged within TTL)
      const now = Date.now();
      const activeSessions = Object.values(sessions || {}).filter(t => now - t < PRESENCE_TTL_MS);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          entries:       entries  || [],
          lastActive:    lastActive || null,
          presenceCount: activeSessions.length,
          contacts:      contacts || [],  // only used by Mike — still returned, UI guards display
        }),
      };
    } catch (e) {
      return { statusCode: 200, headers, body: JSON.stringify({ entries: [], lastActive: null, presenceCount: 0, contacts: [] }) };
    }
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body); }
    catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const { action, entry, id, secret, sessionId, contact } = body;

    // ── ARRIVE — register a session ───────────────────────────────────────
    if (action === 'arrive') {
      if (!sessionId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No sessionId' }) };
      const sessions = (await store.get('sessions', { type: 'json' }).catch(() => ({}))) || {};
      const now = Date.now();
      // Clean stale sessions
      for (const [k, t] of Object.entries(sessions)) {
        if (now - t > PRESENCE_TTL_MS) delete sessions[k];
      }
      sessions[sessionId] = now;
      await store.set('sessions', JSON.stringify(sessions));
      const count = Object.keys(sessions).length;
      return { statusCode: 200, headers, body: JSON.stringify({ presenceCount: count }) };
    }

    // ── DEPART — remove a session ─────────────────────────────────────────
    if (action === 'depart') {
      if (!sessionId) return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
      const sessions = (await store.get('sessions', { type: 'json' }).catch(() => ({}))) || {};
      delete sessions[sessionId];
      await store.set('sessions', JSON.stringify(sessions));
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // ── PING — keep session alive + update lastActive ─────────────────────
    if (action === 'ping') {
      const now = Date.now();
      await store.set('lastActive', JSON.stringify(now));
      if (sessionId) {
        const sessions = (await store.get('sessions', { type: 'json' }).catch(() => ({}))) || {};
        sessions[sessionId] = now;
        await store.set('sessions', JSON.stringify(sessions));
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // ── VALIDATE Mike secret ──────────────────────────────────────────────
    if (action === 'validate') {
      if (!process.env.MIKE_SECRET || secret !== process.env.MIKE_SECRET) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
      }
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
    }

    // ── ADD CONTACT — visitor leaves optional contact info ────────────────
    if (action === 'add_contact') {
      if (!contact?.value?.trim()) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'No contact info' }) };
      }
      const contacts = (await store.get('contacts', { type: 'json' }).catch(() => [])) || [];
      contacts.unshift({
        id:    Date.now(),
        name:  contact.name  || null,
        value: contact.value.trim(),
        date:  new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        note:  contact.note  || null,
      });
      await store.set('contacts', JSON.stringify(contacts));
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // ── REMOVE CONTACT — Mike only ────────────────────────────────────────
    if (action === 'remove_contact') {
      if (!process.env.MIKE_SECRET || secret !== process.env.MIKE_SECRET) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
      }
      let contacts = (await store.get('contacts', { type: 'json' }).catch(() => [])) || [];
      contacts = contacts.filter(c => c.id !== id);
      await store.set('contacts', JSON.stringify(contacts));
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // Load archive entries for remaining actions
    let entries = [];
    try { entries = (await store.get('entries', { type: 'json' })) || []; }
    catch (e) { entries = []; }

    // ── ADD archive entry ─────────────────────────────────────────────────
    if (action === 'add') {
      if (entry.type === 'mike') {
        if (!process.env.MIKE_SECRET || secret !== process.env.MIKE_SECRET) {
          return { statusCode: 403, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
        }
      }
      const newEntry = {
        id:   Date.now(),
        text: entry.text,
        type: entry.type || 'visitor',
        date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      };
      entries.unshift(newEntry);
      await store.set('entries', JSON.stringify(entries));
      return { statusCode: 200, headers, body: JSON.stringify(entries) };
    }

    // ── REMOVE archive entry — Mike only ──────────────────────────────────
    if (action === 'remove') {
      if (!process.env.MIKE_SECRET || secret !== process.env.MIKE_SECRET) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
      }
      entries = entries.filter(e => e.id !== id);
      await store.set('entries', JSON.stringify(entries));
      return { statusCode: 200, headers, body: JSON.stringify(entries) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
