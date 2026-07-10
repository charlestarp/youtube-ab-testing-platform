/**
 * YT Testing — Background Service Worker v3
 * Handles ALL communication with app.example.com
 * Content script only talks to YouTube Studio (same-origin) and this worker.
 */

var API_BASE = "https://app.example.com";

function getSessionToken(callback) {
  chrome.cookies.get({ url: API_BASE, name: "session" }, function(cookie) {
    if (chrome.runtime.lastError) {
      console.log("[yt-testing] Cookie API error:", chrome.runtime.lastError.message);
      callback(null);
      return;
    }
    if (cookie) {
      console.log("[yt-testing] Session cookie found, expires:", new Date(cookie.expirationDate * 1000).toISOString());
    } else {
      console.log("[yt-testing] No session cookie for", API_BASE);
      // List all cookies for debugging
      chrome.cookies.getAll({ domain: "tarpgpt.com" }, function(all) {
        console.log("[yt-testing] All tarpgpt.com cookies:", all.map(function(c) { return c.name; }));
      });
    }
    callback(cookie ? cookie.value : null);
  });
}

function apiRequest(method, path, body, callback) {
  getSessionToken(function(token) {
    if (!token) {
      console.log("[yt-testing] No session token for", path);
      callback(null);
      return;
    }
    var opts = {
      method: method,
      headers: { "Authorization": "Bearer " + token }
    };
    if (body) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    fetch(API_BASE + path, opts)
      .then(function(r) {
        if (!r.ok) {
          console.log("[yt-testing] API " + r.status + " for", path);
          return null;
        }
        return r.json();
      })
      .then(function(data) { callback(data); })
      .catch(function(e) {
        console.log("[yt-testing] API error for", path, e.message);
        callback(null);
      });
  });
}

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.type === "getSession") {
    getSessionToken(function(token) {
      sendResponse(!!token);
    });
    return true;
  }

  if (msg.type === "getVideos") {
    // Fetch running tests, recently completed tests needing data, and retention videos
    apiRequest("GET", "/api/tests?status=running", null, function(tests) {
      var testVideos = [];
      if (tests && Array.isArray(tests)) {
        testVideos = tests.map(function(t) {
          return { video_id: t.video_id, title: t.video_title };
        });
      }
      // Also fetch recently completed tests that have zero measurement data
      apiRequest("GET", "/api/tests/needing-data", null, function(needData) {
        var needDataVideos = [];
        if (needData && Array.isArray(needData)) {
          needDataVideos = needData.map(function(t) {
            return { video_id: t.video_id, title: t.video_title };
          });
        }
        apiRequest("GET", "/api/retention-spikes/pending-videos", null, function(pending) {
          var pendingVideos = [];
          if (pending && Array.isArray(pending)) {
            pendingVideos = pending.map(function(p) {
              return { video_id: p.video_id, title: p.title };
            });
          }
          // Dedupe by video_id
          var seen = {};
          var combined = [];
          testVideos.concat(needDataVideos).concat(pendingVideos).forEach(function(v) {
            if (!seen[v.video_id]) {
              seen[v.video_id] = true;
              combined.push(v);
            }
          });
          console.log("[yt-testing] Videos to poll:", combined.length, "(running:" + testVideos.length + ", needing-data:" + needDataVideos.length + ", retention:" + pendingVideos.length + ")");
          sendResponse(combined);
        });
      });
    });
    return true;
  }

  if (msg.type === "postSnapshot") {
    apiRequest("POST", "/api/studio/ext-snapshot", msg.data, function(result) {
      var ok = result && result.ok;
      if (ok) {
        console.log("[yt-testing] Snapshot saved:", msg.data.video_id, "imp=" + msg.data.impressions, "views=" + msg.data.views);
      }
      sendResponse(ok);
    });
    return true;
  }

  if (msg.type === "postHourly") {
    var metricKeys = msg.data.metrics ? Object.keys(msg.data.metrics) : [];
    console.log("[yt-testing] postHourly:", msg.data.video_id, "timestamps:", (msg.data.timestamps || []).length, "metrics:", metricKeys.join(",") || "none (views only)");
    apiRequest("POST", "/api/studio/hourly-data", msg.data, function(result) {
      sendResponse(result && result.ok);
    });
    return true;
  }
});

console.log("[yt-testing] Background service worker v3 ready");
