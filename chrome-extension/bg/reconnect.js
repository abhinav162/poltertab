// PolterTab — the reconnect schedule for the background service worker.
//
// When the bridge connection drops, dial again at once, then back off 1 s,
// 2 s, 4 s … capped at 30 s. Chrome clamps chrome.alarms to 30 s, so an
// alarm-only reconnect left the extension away for up to half a minute after
// a Primary handed over, and every command in that gap failed. These timers
// only run while the worker is awake; the reconnect alarm in background.js
// stays armed as the backstop for a worker that was suspended mid-schedule.
//
// One timer at a time, cleared on every connect, so the alarm and this loop
// can both call connect() without opening two sockets — connect() itself
// refuses while a socket is CONNECTING or OPEN. Loaded by background.js with
// importScripts; exports one factory and registers no listeners.

self.PT = self.PT || {};

self.PT.makeReconnect = ({ connect }) => {
  const FIRST_DELAY_MS = 1000;
  const MAX_DELAY_MS = 30000;
  // 0 means the next failure is redialled immediately.
  let failures = 0;
  let timer = null;

  function cancel() {
    clearTimeout(timer);
    timer = null;
  }

  return {
    // A socket opened: the next outage starts the schedule from the top.
    connected() {
      cancel();
      failures = 0;
    },
    // A socket closed, whether or not it ever opened.
    disconnected() {
      cancel();
      if (failures === 0) {
        failures = 1;
        connect();
        return;
      }
      const delay = Math.min(FIRST_DELAY_MS * 2 ** (failures - 1), MAX_DELAY_MS);
      failures++;
      timer = setTimeout(() => {
        timer = null;
        connect();
      }, delay);
    },
    // The port changed: whatever was scheduled was for the old one.
    reset() {
      cancel();
      failures = 0;
    },
  };
};
