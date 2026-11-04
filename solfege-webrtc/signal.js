// The introduction: two browsers that share an invitation's key pass each other messages, through
// a relay that is treated as a stranger. This is the only file that knows the relay, which is
// used only until the browsers have a connection. See ARCHITECTURE.md, section 3.
const text = new TextEncoder();
const toBase64 = bytes => btoa(String.fromCharCode(...bytes));
const fromBase64 = base64 => Uint8Array.from(atob(base64), char => char.charCodeAt(0));

// From the key, the topic to meet on and the key that encrypts each message, so that the relay
// is never given the key itself. It carries noise, on a topic that says nothing about the room.
async function derive(secret) {
  const material = await crypto.subtle.importKey("raw", text.encode(secret), "HKDF", false, ["deriveBits", "deriveKey"]);
  const using = info => ({name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: text.encode(info)});
  const bits = await crypto.subtle.deriveBits(using("solfege-webrtc topic"), material, 192);
  const key = await crypto.subtle.deriveKey(using("solfege-webrtc messages"), material, {name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
  return {topic: Array.from(new Uint8Array(bits), byte => byte.toString(16).padStart(2, "0")).join(""), key};
}

// {retry} is how long to wait before listening again, if the relay has refused to carry on.
export async function signal(relay, secret, {retry = 10000} = {}) {
  const {topic, key} = await derive(secret);
  let source = null, timer = null, heard = null, ready = null;

  async function seal(message) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt({name: "AES-GCM", iv}, key, text.encode(JSON.stringify(message)));
    return toBase64([...iv, ...new Uint8Array(sealed)]);
  }
  // Whatever can't be opened isn't from someone with the key, and is ignored.
  async function unseal(box) {
    try {
      const bytes = fromBase64(box);
      const opened = await crypto.subtle.decrypt({name: "AES-GCM", iv: bytes.slice(0, 12)}, key, bytes.slice(12));
      return JSON.parse(new TextDecoder().decode(opened));
    } catch {
      return null;
    }
  }

  function stop() {
    clearTimeout(timer);
    source?.close();
    source = null;
  }
  function start() {
    stop();
    source = new EventSource(`${relay}/${topic}/sse`);
    source.addEventListener("open", event => { if (event.data) ready(); });   // the relay's, not the browser's
    source.onmessage = async event => {
      const message = await unseal(JSON.parse(event.data).message);
      if (message && source) heard(message);
    };
    // The browser tries again by itself, unless the relay has answered with an error.
    source.onerror = () => {
      if (source?.readyState === EventSource.CLOSED) timer = setTimeout(start, retry);
    };
  }

  return {
    seal,
    // `onMessage` gets each message, also your own. `onReady` is called each time the relay
    // has started listening: nothing sent before that moment reaches you.
    listen(onMessage, onReady) {
      heard = onMessage;
      ready = onReady;
      start();
    },
    async send(message) {
      // To ntfy: keep nothing, and don't pass it on to phones through its own use of Firebase.
      const response = await fetch(`${relay}/${topic}`, {method: "POST", headers: {Cache: "no", Firebase: "no"}, body: await seal(message)});
      if (!response.ok) throw new Error(`the relay answered ${response.status}`);
    },
    restart: start,
    close: stop,
  };
}
