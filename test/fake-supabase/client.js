/* Browser stand-in for supabase-js v2 (only the parts WAZAMBI uses). Test use only. */
(function () {
  function createClient(url, _key, opts = {}) {
    const storageKey = opts.auth?.storageKey || 'sb-auth';
    const authListeners = new Set();
    const readSession = () => {
      try { return JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { return null; }
    };
    const writeSession = s => {
      if (s) localStorage.setItem(storageKey, JSON.stringify(s));
      else localStorage.removeItem(storageKey);
    };
    const token = () => readSession()?.access_token || '';
    const post = async (path, body, raw = false) => {
      const r = await fetch(url + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: raw ? body : JSON.stringify(body)
      });
      return r.json();
    };

    // ---------------- auth ----------------
    const auth = {
      async getSession() { return { data: { session: readSession() }, error: null }; },
      async getUser() { const s = readSession(); return { data: { user: s?.user || null }, error: null }; },
      async signInWithPassword({ email, password }) {
        const r = await post('/fake/auth/login', { email, password });
        if (r.error) return { data: {}, error: { message: r.error } };
        writeSession(r);
        authListeners.forEach(cb => cb('SIGNED_IN', r));
        return { data: { session: r, user: r.user }, error: null };
      },
      async signUp({ email }) { return { data: { user: { id: 'x', email, identities: [{}] }, session: null }, error: null }; },
      async signInWithOtp() { return { data: {}, error: null }; },
      async signInWithOAuth() { return { data: {}, error: { message: 'Unsupported provider: provider is not enabled' } }; },
      async resetPasswordForEmail() { return { data: {}, error: null }; },
      async updateUser() { return { data: {}, error: null }; },
      async signOut() {
        writeSession(null);
        authListeners.forEach(cb => cb('SIGNED_OUT', null));
        return { error: null };
      },
      onAuthStateChange(cb) {
        authListeners.add(cb);
        return { data: { subscription: { unsubscribe: () => authListeners.delete(cb) } } };
      }
    };

    // ---------------- query builder ----------------
    function from(table) {
      const q = { table, op: 'select', filters: [] };
      const b = {
        select(cols, o = {}) { if (q.op === 'select') q.cols = cols; else q.returning = true; if (o.head) q.head = true; if (o.count) q.count = o.count; return b; },
        insert(values) { q.op = 'insert'; q.values = values; return b; },
        upsert(values, o = {}) { q.op = 'upsert'; q.values = values; q.onConflict = o.onConflict; return b; },
        update(values) { q.op = 'update'; q.values = values; return b; },
        delete() { q.op = 'delete'; return b; },
        eq(col, val) { q.filters.push({ op: 'eq', col, val }); return b; },
        neq(col, val) { q.filters.push({ op: 'neq', col, val }); return b; },
        lt(col, val) { q.filters.push({ op: 'lt', col, val }); return b; },
        gt(col, val) { q.filters.push({ op: 'gt', col, val }); return b; },
        is(col, val) { q.filters.push({ op: 'is', col, val }); return b; },
        in(col, val) { q.filters.push({ op: 'in', col, val }); return b; },
        or(expr) { q.filters.push({ op: 'or', val: expr }); return b; },
        order(col, o = {}) { q.order = { col, ascending: o.ascending !== false }; return b; },
        limit(n) { q.limit = n; return b; },
        single() { q.single = true; q.must = true; return b; },
        maybeSingle() { q.single = true; return b; },
        then(resolve, reject) {
          return post('/fake/query', q).then(r => {
            if (r.error) return { data: null, error: { message: r.error, code: r.code } };
            let data = r.data;
            if (q.single && Array.isArray(data)) data = data[0] ?? null;
            if (q.single && q.must && !data) return { data: null, error: { message: 'No rows', code: 'PGRST116' } };
            return { data, error: null, count: r.count };
          }).then(resolve, reject);
        }
      };
      return b;
    }

    async function rpc(fn, args = {}) {
      const r = await post(`/fake/rpc/${fn}`, args);
      return r.error ? { data: null, error: { message: r.error } } : { data: r.data, error: null };
    }

    // ---------------- storage ----------------
    const storage = {
      from(bucket) {
        return {
          async upload(path, blob, o = {}) {
            const r = await fetch(`${url}/storage/v1/object/${bucket}/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': o.contentType || blob.type }, body: blob });
            return r.ok ? { data: { path }, error: null } : { data: null, error: { message: 'upload failed' } };
          },
          getPublicUrl(path) { return { data: { publicUrl: `${url}/fake/storage/${bucket}/${path}` } }; },
          async createSignedUrls(paths) {
            return { data: paths.map(p => ({ path: p, signedUrl: `${url}/fake/storage/${bucket}/${p}?token=t` })), error: null };
          },
          async remove() { return { data: [], error: null }; }
        };
      }
    };

    // ---------------- realtime ----------------
    let source = null;
    const channels = new Set();
    function ensureSource() {
      const uid = token().split(':')[0];
      if (source || !uid) return;
      source = new EventSource(`${url}/fake/events?uid=${uid}`);
      source.onmessage = e => {
        const msg = JSON.parse(e.data);
        channels.forEach(ch => ch._dispatch(msg));
      };
    }
    function matchFilter(row, filter) {
      if (!filter) return true;
      const [col, rest] = filter.split('=');
      const [op, val] = rest.split('.');
      return op === 'eq' ? String(row?.[col]) === val : true;
    }
    function channel(name, o = {}) {
      const handlers = [];
      let presenceState = {};
      const selfKey = o.config?.presence?.key;
      const ch = {
        topic: name,
        on(type, filter, cb) { handlers.push({ type, filter, cb }); return ch; },
        subscribe(cb) {
          ensureSource();
          channels.add(ch);
          setTimeout(() => cb?.('SUBSCRIBED'), 30);
          return ch;
        },
        async send({ event, payload }) {
          await post('/fake/broadcast', { channel: name, event, payload, from: token().split(':')[0] });
          return 'ok';
        },
        async track(state) { await post('/fake/presence', { channel: name, key: selfKey, state }); return 'ok'; },
        presenceState() { return presenceState; },
        unsubscribe() { channels.delete(ch); if (selfKey) post('/fake/presence', { channel: name, key: selfKey, leave: true }); },
        _dispatch(msg) {
          for (const h of handlers) {
            if (msg.kind === 'db' && h.type === 'postgres_changes' && h.filter.table === msg.table &&
              (h.filter.event === '*' || h.filter.event === msg.eventType) &&
              matchFilter(msg.eventType === 'DELETE' ? msg.old : msg.new, h.filter.filter)) {
              h.cb({ eventType: msg.eventType, new: msg.new, old: msg.old, table: msg.table });
            }
            if (msg.kind === 'broadcast' && h.type === 'broadcast' && msg.channel === name && h.filter.event === msg.event) {
              const self = o.config?.broadcast?.self;
              if (self === false && msg.from === token().split(':')[0]) continue;
              h.cb({ event: msg.event, payload: msg.payload });
            }
            if (msg.kind === 'presence' && h.type === 'presence' && msg.channel === name) {
              presenceState = msg.state;
              h.cb();
            }
          }
        }
      };
      return ch;
    }
    function removeChannel(ch) { ch.unsubscribe(); return Promise.resolve('ok'); }

    return { auth, from, rpc, storage, channel, removeChannel };
  }
  window.supabase = { createClient };
})();
