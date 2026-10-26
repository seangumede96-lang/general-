// Inside the app there is no browser-extension API, so give the gallery the
// small part of it that it uses: storage (kept by the app on the phone) and
// no-op listeners for the extension-only messages.
window.__xbgExt = (function () {
  const bridge = window.XbgAndroid;
  const read = (key) => {
    try {
      const value = bridge.get(key);
      return value ? JSON.parse(value) : undefined;
    } catch (e) {
      return undefined;
    }
  };
  const local = {
    get(keys) {
      const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : [];
      const out = {};
      for (const key of list) {
        const value = read(key);
        if (value !== undefined) out[key] = value;
      }
      return Promise.resolve(out);
    },
    set(values) {
      try {
        for (const [key, value] of Object.entries(values)) bridge.set(key, JSON.stringify(value));
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e);
      }
    },
  };
  return {
    storage: { local, onChanged: { addListener() {} } },
    runtime: { onMessage: { addListener() {} } },
  };
})();
