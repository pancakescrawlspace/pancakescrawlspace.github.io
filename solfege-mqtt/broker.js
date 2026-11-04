// Two browsers that share an invitation's key pass each other every message, through a public MQTT
// broker that is treated as a stranger, as is anyone else on it. This is the only file that knows
// MQTT: a small client of its own, as only four kinds of packet are needed, and encryption, which
// is what keeps everything else out. See ARCHITECTURE.md, section 3.
const encoder = new TextEncoder();
const toBase64 = bytes => btoa(String.fromCharCode(...bytes));
const fromBase64 = base64 => Uint8Array.from(atob(base64), char => char.charCodeAt(0));

// --- MQTT's packets -----------------------------------------------------------------------

const withLength = text => {
  const bytes = encoder.encode(text);
  return [bytes.length >> 8, bytes.length & 255, ...bytes];
};
function packet(first, body) {
  const size = [];
  let left = body.length;
  do {
    const digit = left % 128;
    left = Math.floor(left / 128);
    size.push(left ? digit | 128 : digit);
  } while (left);
  return Uint8Array.from([first, ...size, ...body]);
}

const CONNACK = 2, PUBLISH = 3, SUBACK = 9, PINGRESP = 13;
const CLEAN_SESSION_AND_WILL = 0x06;
export const PING = Uint8Array.from([0xC0, 0]);
export const connectPacket = ({clientId, keepalive, willTopic, will}) => packet(0x10, [
  ...withLength("MQTT"), 4, CLEAN_SESSION_AND_WILL, keepalive >> 8, keepalive & 255,
  ...withLength(clientId), ...withLength(willTopic), ...withLength(will),
]);
export const subscribePacket = topic => packet(0x82, [0, 1, ...withLength(topic), 0]);
// At QoS 0, and never retained: nothing is left on the broker.
export const publishPacket = (topic, text) => packet(0x30, [...withLength(topic), ...encoder.encode(text)]);

// Takes the bytes as they come, in pieces of any size, and calls `onPacket(type, body)` for each
// whole packet. Throws on nonsense.
export function packetReader(onPacket) {
  let waiting = new Uint8Array(0);
  return bytes => {
    const joined = new Uint8Array(waiting.length + bytes.length);
    joined.set(waiting);
    joined.set(bytes, waiting.length);
    waiting = joined;
    while (true) {
      let at = 1, size = 0, factor = 1, more = true;
      while (more) {
        if (at >= waiting.length) {
          if (at > 4) throw new Error("a length of more than four bytes");
          return;
        }
        if (at > 4) throw new Error("a length of more than four bytes");
        const digit = waiting[at++];
        size += (digit & 127) * factor;
        factor *= 128;
        more = Boolean(digit & 128);
      }
      if (waiting.length < at + size) return;
      const type = waiting[0] >> 4, body = waiting.slice(at, at + size);
      waiting = waiting.slice(at + size);
      onPacket(type, body);
    }
  };
}

// --- the topic ----------------------------------------------------------------------------

// From the key, the topic to meet on and the key that encrypts each message, so that the broker
// is never given the key itself. It carries noise, on a topic that says nothing about the room.
async function derive(secret) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveBits", "deriveKey"]);
  const using = info => ({name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: encoder.encode(info)});
  const bits = await crypto.subtle.deriveBits(using("solfege-mqtt topic"), material, 192);
  const key = await crypto.subtle.deriveKey(using("solfege-mqtt messages"), material, {name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
  return {topic: Array.from(new Uint8Array(bits), byte => byte.toString(16).padStart(2, "0")).join(""), key};
}

// {keepalive} is how many seconds may pass between signs of life, for the broker, which gives up
// after one and a half times that. {pingWait} is how long to wait for an answer to a ping, and
// {retry} how long before connecting again, which doubles up to {longestRetry}.
export async function openTopic(address, secret, {keepalive = 60, pingWait = 10000, retry = 1000, longestRetry = 30000} = {}) {
  const {topic, key} = await derive(secret);
  let socket = null, ready = false, stopped = true, silent = false;
  let timer = null, pings = null, unanswered = null, wait = retry;
  let heard = null, onReady = null, onLost = null, makeWill = null;

  async function seal(message) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt({name: "AES-GCM", iv}, key, encoder.encode(JSON.stringify(message)));
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

  function stopPinging() {
    clearInterval(pings);
    clearTimeout(unanswered);
    unanswered = null;
  }
  function hangUp() {
    clearTimeout(timer);
    stopPinging();
    ready = false;
    const old = socket;
    socket = null;
    // Closing without a proper goodbye makes the broker send the will, which is what's wanted.
    old?.close();
  }
  function lost() {
    hangUp();
    onLost?.();
    if (stopped) return;
    timer = setTimeout(start, wait);
    wait = Math.min(wait * 2, longestRetry);
  }
  function ping() {
    if (silent || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(PING);
    unanswered ??= setTimeout(lost, pingWait);
  }

  async function start() {
    hangUp();
    stopped = false;
    silent = false;
    const will = await makeWill();
    if (stopped) return;
    const mine = new WebSocket(address, "mqtt");
    mine.binaryType = "arraybuffer";
    socket = mine;
    const read = packetReader((type, body) => {
      if (mine !== socket) return;
      if (type === CONNACK) {
        if (body[1] === 0) mine.send(subscribePacket(topic));
        else lost();
      } else if (type === SUBACK) {
        ready = true;
        wait = retry;
        pings = setInterval(ping, keepalive * 1000);
        onReady?.();
      } else if (type === PINGRESP) {
        clearTimeout(unanswered);
        unanswered = null;
      } else if (type === PUBLISH) {
        const size = (body[0] << 8) + body[1];
        unseal(new TextDecoder().decode(body.slice(2 + size))).then(message => {
          if (message && mine === socket) heard(message);
        });
      }
    });
    mine.onopen = () => {
      if (mine === socket) mine.send(connectPacket({clientId: `s${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`, keepalive, willTopic: topic, will}));
    };
    mine.onmessage = event => {
      try {
        read(new Uint8Array(event.data));
      } catch (error) {
        console.warn(error);
        if (mine === socket) lost();
      }
    };
    mine.onclose = () => { if (mine === socket) lost(); };
  }

  return {
    seal,
    // `onMessage` gets each message, also your own. `onReady` is called each time it has started
    // listening: nothing sent before that moment reaches you. `onLost` is called when the
    // connection has gone. `will` makes the sealed message for the broker to send if this
    // connection ends, each time it connects.
    listen(onMessage, onReadyNow, onLostNow, will) {
      heard = onMessage;
      onReady = onReadyNow;
      onLost = onLostNow;
      makeWill = will;
      start();
    },
    async send(message) {
      const box = await seal(message);
      if (!ready) throw new Error("not connected");
      socket.send(publishPacket(topic, box));
    },
    // Connects afresh, with the shortest wait.
    restart() {
      wait = retry;
      start();
    },
    close() {
      stopped = true;
      hangUp();
    },
    test: {
      // The connection stays open, but no more signs of life go out, like a device going to sleep.
      silence() {
        silent = true;
        stopPinging();
      },
      // As above, and it connects anew, leaving the old connection for the broker to give up on.
      abandon() {
        const old = socket;
        silent = false;
        stopPinging();
        socket = null;
        ready = false;
        old.onclose = null;
        start();
      },
    },
  };
}
