/**
 * YT Testing — Page Script v10 (MAIN world)
 * Fetches YouTube Studio analytics from keyMetricCardConfig.
 * mainSeries datums (x=timestamp ms, y=cumulative value) provide full time series.
 * The latestActivityCardConfig request has been removed — totals request is sufficient.
 */

(function() {
  console.log("[yt-testing-page] Page script v15 loaded (fetch + XHR intercept, reach-totals fallback)");

  // Intercept BOTH XHR and fetch() to capture get_screen Reach tab responses.
  // YouTube Studio uses fetch() for API calls, not XHR.

  // Intercept fetch()
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    var url = typeof input === "string" ? input : (input && input.url ? input.url : "");
    var bodyStr = init && init.body ? (typeof init.body === "string" ? init.body : "") : "";

    if (url.indexOf("get_screen") !== -1 && bodyStr.indexOf("ANALYTICS_TAB_ID_REACH") !== -1) {
      return origFetch.apply(this, arguments).then(function(response) {
        var clone = response.clone();
        clone.text().then(function(text) {
          try {
            if (text && text.length > 1000) {
              if (text.indexOf(")]}'") === 0) text = text.substring(text.indexOf("\n") + 1);
              var data = JSON.parse(text);
              console.log("[yt-testing-page] REACH fetch intercepted, length:", text.length);
              window.postMessage({ type: "yt-testing-reach-data", data: data }, "*");
            }
          } catch(e) { console.log("[yt-testing-page] Reach fetch parse error:", e.message); }
        });
        return response;
      });
    }

    // Also intercept get_cards to detect video context
    if (url.indexOf("get_cards") !== -1) {
      return origFetch.apply(this, arguments).then(function(response) {
        var clone = response.clone();
        clone.text().then(function(text) {
          try {
            if (text && text.length > 500) {
              if (text.indexOf(")]}'") === 0) text = text.substring(text.indexOf("\n") + 1);
              var data = JSON.parse(text);
              console.log("[yt-testing-page] get_cards fetch intercepted");
              window.postMessage({ type: "yt-testing-cards-data", data: data }, "*");
            }
          } catch(e) {}
        });
        return response;
      });
    }

    return origFetch.apply(this, arguments);
  };

  // Legacy XHR intercept (fallback)
  var OrigXHR = window.XMLHttpRequest;
  var origOpen = OrigXHR.prototype.open;
  var origSend = OrigXHR.prototype.send;
  OrigXHR.prototype.open = function(method, url) { this._ytUrl = url; return origOpen.apply(this, arguments); };
  OrigXHR.prototype.send = function(body) {
    var self = this;
    if (self._ytUrl && self._ytUrl.indexOf("get_screen") !== -1 && body) {
      var bodyStr = typeof body === "string" ? body : "";
      if (bodyStr.indexOf("ANALYTICS_TAB_ID_REACH") !== -1) {
        var origOnLoad = self.onload;
        self.onload = function() {
          try {
            var text = self.responseText;
            if (text && text.length > 1000) {
              if (text.indexOf(")]}'") === 0) text = text.substring(text.indexOf("\n") + 1);
              var data = JSON.parse(text);
              console.log("[yt-testing-page] REACH XHR intercepted, length:", text.length);
              window.postMessage({ type: "yt-testing-reach-data", data: data }, "*");
            }
          } catch(e) {}
          if (origOnLoad) origOnLoad.apply(this, arguments);
        };
      }
    }
    return origSend.apply(this, arguments);
  };

  function getCookie(name) {
    var cookies = document.cookie.split(";");
    for (var i = 0; i < cookies.length; i++) {
      var c = cookies[i].trim();
      if (c.indexOf(name + "=") === 0) return c.substring(name.length + 1);
    }
    return null;
  }

  async function getSapisidHash(sapisid, origin) {
    var timestamp = Math.floor(Date.now() / 1000);
    var input = timestamp + " " + sapisid + " " + origin;
    var data = new TextEncoder().encode(input);
    var hashBuffer = await crypto.subtle.digest("SHA-1", data);
    var hashArray = Array.from(new Uint8Array(hashBuffer));
    var hash = hashArray.map(function(b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    return "SAPISIDHASH " + timestamp + "_" + hash;
  }

  function getYtCfg(key) {
    try {
      if (window.ytcfg && typeof window.ytcfg.get === "function") return window.ytcfg.get(key);
    } catch(e) {}
    return null;
  }

  function buildTotalsBody(videoId) {
    var body = {
      screenConfig: {
        entity: { videoId: videoId },
        timePeriod: {
          referencePoint: "TIME_PERIOD_REFERENCE_POINT_SINCE_PUBLISH",
          timePeriodType: "ANALYTICS_TIME_PERIOD_TYPE_SINCE_PUBLISH",
          entity: { videoId: videoId }
        },
        currency: "AUD",
        timeZoneOffsetSecs: 36000
      },
      cardConfigs: [
        {
          autoUpdateInterval: "ANALYTICS_AUTO_UPDATE_INTERVAL_NEVER",
          keyMetricCardConfig: {
            timePeriod: {},
            metricTabConfigs: [
              { metric: "VIDEO_THUMBNAIL_IMPRESSIONS" },
              { metric: "VIDEO_THUMBNAIL_IMPRESSIONS_VTR" },
              { metric: "EXTERNAL_VIEWS" },
              { metric: "EXTERNAL_WATCH_TIME" },
              { metric: "AVERAGE_WATCH_TIME" },
              { metric: "SUBSCRIBERS_NET_CHANGE" }
            ]
          },
          failureMode: "ANALYTICS_CARD_FAILURE_MODE_FAIL_PAGE"
        }
      ]
    };
    var ctx = getYtCfg("INNERTUBE_CONTEXT");
    if (ctx) body.context = ctx;
    return body;
  }

  // Removed _reachFetchedFor gate — reach data should be fetched every cycle
  // so hourly CTR stays up to date as YouTube processes data

  async function fetchVideoData(videoId) {
    var sapisid = getCookie("SAPISID") || getCookie("__Secure-3PAPISID");
    var origin = "https://studio.youtube.com";

    if (!sapisid) return { status: 0, response: null };

    var headers = {
      "Content-Type": "application/json",
      "Authorization": await getSapisidHash(sapisid, origin),
      "X-Origin": origin
    };

    var sessionIndex = getYtCfg("SESSION_INDEX");
    headers["X-Goog-AuthUser"] = sessionIndex !== null ? String(sessionIndex) : "0";
    var pageId = getYtCfg("DELEGATED_SESSION_ID") || getYtCfg("PAGE_CL") || getYtCfg("CHANNEL_ID");
    if (pageId) headers["X-Goog-PageId"] = pageId;

    var result = { totals: null };
    var apiUrl = origin + "/youtubei/v1/yta_web/get_cards?alt=json";

    // Request 1: Totals (since publish)
    var r1 = await fetch(apiUrl, {
      method: "POST", headers: headers, credentials: "include",
      body: JSON.stringify(buildTotalsBody(videoId))
    });
    if (r1.status === 200) {
      var t1 = await r1.text();
      if (t1.indexOf(")]}'") === 0) t1 = t1.substring(t1.indexOf("\n") + 1);
      try {
        var d1 = JSON.parse(t1);
        var m = {};
        var hourlyMetrics = {};
        if (d1.cards) {
          for (var ci = 0; ci < d1.cards.length; ci++) {
            var card = d1.cards[ci];
            if (card.keyMetricCardData && card.keyMetricCardData.keyMetricTabs) {
              for (var ti = 0; ti < card.keyMetricCardData.keyMetricTabs.length; ti++) {
                var tab = card.keyMetricCardData.keyMetricTabs[ti];
                if (tab.primaryContent && tab.primaryContent.metric) {
                  m[tab.primaryContent.metric] = tab.primaryContent.total;

                  // Extract time series from mainSeries.datums (x=timestamp, y=value)
                  var series = tab.primaryContent.mainSeries;
                  if (series && series.datums && series.datums.length > 0) {
                    var values = [];
                    for (var di = 0; di < series.datums.length; di++) {
                      values.push(series.datums[di].y || 0);
                    }
                    hourlyMetrics[tab.primaryContent.metric] = values;

                    // Extract timestamps once (same for all metrics)
                    if (!result.timeSeriesTimestamps) {
                      var timestamps = [];
                      for (var dti = 0; dti < series.datums.length; dti++) {
                        timestamps.push(series.datums[dti].x);
                      }
                      result.timeSeriesTimestamps = timestamps;
                      console.log("[yt-testing-page]", videoId, "series:", series.datums.length, "points, timeUnit:", series.timeUnit,
                        "first:", new Date(timestamps[0]).toISOString(), "last:", new Date(timestamps[timestamps.length-1]).toISOString());
                    }
                  }
                }
              }
            }
          }
        }
        result.totals = {
          views: m.EXTERNAL_VIEWS || 0,
          impressions: m.VIDEO_THUMBNAIL_IMPRESSIONS || m.IMPRESSIONS || 0,
          ctr: m.VIDEO_THUMBNAIL_IMPRESSIONS_VTR || m.IMPRESSIONS_CTR || 0,
          watch_time_hours: (m.EXTERNAL_WATCH_TIME || 0) / 3600000,
          avg_view_duration_sec: (m.AVERAGE_WATCH_TIME || 0) / 1000,
          subscribers_net: m.SUBSCRIBERS_NET_CHANGE || 0
        };
        if (Object.keys(hourlyMetrics).length > 0) {
          result.hourlyMetrics = hourlyMetrics;
        }
        console.log("[yt-testing-page]", videoId, "totals: imp=" + result.totals.impressions, "views=" + result.totals.views);
      } catch(e) { console.log("[yt-testing-page] Totals parse error:", e.message); }
    } else {
      console.log("[yt-testing-page] Totals failed:", r1.status);
    }

    // Request 2: get_screen with Reach tab — gives per-hour CTR (non-cumulative)
    // Only fetch once per hour (heavy call, ~570KB response)
    var reachCacheKey = "yt-testing-reach-" + videoId;
    var lastReachFetch = 0;
    try { lastReachFetch = parseInt(localStorage.getItem(reachCacheKey) || "0"); } catch(e) {}
    var shouldFetchReach = (Date.now() - lastReachFetch) > 300000; // 5 minutes (was 1 hour)

    if (shouldFetchReach) try {
      try { localStorage.setItem(reachCacheKey, String(Date.now())); } catch(e) {}
      var ctx = getYtCfg("INNERTUBE_CONTEXT");
      var screenBody = {
        screenConfig: {
          entity: { videoId: videoId },
          currency: "AUD",
          timeZoneOffsetSecs: 36000
        },
        desktopState: { tabId: "ANALYTICS_TAB_ID_REACH" }
      };
      if (ctx) screenBody.context = ctx;

      var r2 = await fetch(origin + "/youtubei/v1/yta_web/get_screen?alt=json", {
        method: "POST", headers: headers, credentials: "include",
        body: JSON.stringify(screenBody)
      });
      if (r2.status === 200) {
        var t2 = await r2.text();
        if (t2.indexOf(")]}'") === 0) t2 = t2.substring(t2.indexOf("\n") + 1);
        var d2 = JSON.parse(t2);
        // Extract ALL data from Reach tab: cumulative (impressions, views) + non-cumulative (CTR)
        if (!result.reachHourly) result.reachHourly = {};
        if (!result.reachCumulative) result.reachCumulative = {};
        if (d2.cards) {
          for (var ci2 = 0; ci2 < d2.cards.length; ci2++) {
            var card2 = d2.cards[ci2];
            if (card2.keyMetricCardData && card2.keyMetricCardData.keyMetricTabs) {
              for (var ti2 = 0; ti2 < card2.keyMetricCardData.keyMetricTabs.length; ti2++) {
                var tab2 = card2.keyMetricCardData.keyMetricTabs[ti2];
                var s2 = tab2.primaryContent?.mainSeries;
                var metric2 = tab2.primaryContent?.metric;
                if (!s2 || !s2.datums || !metric2) continue;

                if (!s2.isCumulative && s2.timeUnit === "TIME_PERIOD_UNIT_NTH_HOURS") {
                  // Non-cumulative hourly data (CTR, subs)
                  result.reachHourly[metric2] = { timestamps: [], values: [] };
                  for (var di2 = 0; di2 < s2.datums.length; di2++) {
                    result.reachHourly[metric2].timestamps.push(s2.datums[di2].x);
                    result.reachHourly[metric2].values.push(s2.datums[di2].y || 0);
                  }
                  console.log("[yt-testing-page]", videoId, "reach hourly", metric2, ":", s2.datums.length, "pts (non-cumulative)");
                } else if (s2.isCumulative) {
                  // Cumulative data (impressions, views, watch time)
                  result.reachCumulative[metric2] = { timestamps: [], values: [] };
                  for (var di3 = 0; di3 < s2.datums.length; di3++) {
                    result.reachCumulative[metric2].timestamps.push(s2.datums[di3].x);
                    result.reachCumulative[metric2].values.push(s2.datums[di3].y || 0);
                  }
                  console.log("[yt-testing-page]", videoId, "reach cumulative", metric2, ":", s2.datums.length, "pts");
                }
              }
            }
          }
        }
      }
    } catch(e) { console.log("[yt-testing-page] Reach screen error:", e.message); }

    // FALLBACK (added 2026-06-25): as of ~2026-06-24 YouTube's get_cards stopped
    // returning cumulative totals — primaryContent.total comes back 0, so the
    // totals snapshot was never sent (badge stuck "0/1", test grid all zeros).
    // The Reach (get_screen) cumulative series still returns real values, so when
    // get_cards gave us nothing usable, derive the snapshot totals from Reach.
    function lastNonZero(series) {
      if (!series || !series.values || !series.values.length) return 0;
      for (var i = series.values.length - 1; i >= 0; i--) {
        if (series.values[i] && series.values[i] > 0) return series.values[i];
      }
      return series.values[series.values.length - 1] || 0;
    }
    var rc = result.reachCumulative || {};
    var reachImp = lastNonZero(rc["VIDEO_THUMBNAIL_IMPRESSIONS"]);
    var reachViews = lastNonZero(rc["EXTERNAL_VIEWS"]);
    var totalsEmpty = !result.totals || (result.totals.impressions === 0 && result.totals.views === 0);
    if (totalsEmpty && (reachImp > 0 || reachViews > 0)) {
      var prev = result.totals || {};
      var reachWt = lastNonZero(rc["EXTERNAL_WATCH_TIME"]);
      result.totals = {
        views: reachViews || prev.views || 0,
        impressions: reachImp || prev.impressions || 0,
        ctr: prev.ctr || 0, // per-slot CTR is backfilled server-side from reach hourly VTR
        watch_time_hours: reachWt ? reachWt / 3600000 : (prev.watch_time_hours || 0),
        avg_view_duration_sec: prev.avg_view_duration_sec || 0,
        subscribers_net: prev.subscribers_net || 0
      };
      console.log("[yt-testing-page]", videoId, "totals via REACH fallback: imp=" + result.totals.impressions + " views=" + result.totals.views);
    }

    // Request 3: get_screen with Engagement tab — gives audience retention curve
    try {
      var engBody = {
        screenConfig: {
          entity: { videoId: videoId },
          currency: "AUD",
          timeZoneOffsetSecs: 36000
        },
        desktopState: { tabId: "ANALYTICS_TAB_ID_ENGAGEMENT" }
      };
      var ctxE = getYtCfg("INNERTUBE_CONTEXT");
      if (ctxE) engBody.context = ctxE;

      var r3 = await fetch(origin + "/youtubei/v1/yta_web/get_screen?alt=json", {
        method: "POST", headers: headers, credentials: "include",
        body: JSON.stringify(engBody)
      });
      if (r3.status === 200) {
        var t3 = await r3.text();
        if (t3.indexOf(")]}'") === 0) t3 = t3.substring(t3.indexOf("\n") + 1);
        var d3 = JSON.parse(t3);
        if (d3.cards) {
          for (var ci3 = 0; ci3 < d3.cards.length; ci3++) {
            var card3 = d3.cards[ci3];
            // Audience retention highlights card
            if (card3.audienceRetentionHighlightsCardData) {
              var videosData = card3.audienceRetentionHighlightsCardData.videosData;
              if (videosData && videosData.length > 0) {
                var vData = videosData[0];
                if (vData.retentionValues) {
                  result.retentionValues = vData.retentionValues;
                  console.log("[yt-testing-page]", videoId, "retention:", vData.retentionValues.length, "points");
                }
                if (vData.metricTotals && vData.metricTotals.avgPercentageWatched !== undefined) {
                  var rawPct = vData.metricTotals.avgPercentageWatched;
                  result.avgPercentageWatched = rawPct < 1 ? rawPct * 100 : rawPct;
                }
              }
            }
          }
        }
      }
    } catch(e) { console.log("[yt-testing-page] Engagement screen error:", e.message); }

    return { status: result.totals ? 200 : 0, data: result };
  }

  window.addEventListener("message", async function(event) {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== "yt-testing-fetch") return;

    var videoId = event.data.videoId;
    console.log("[yt-testing-page] Fetching", videoId);

    try {
      var result = await fetchVideoData(videoId);
      window.postMessage({
        type: "yt-testing-result",
        videoId: videoId,
        status: result.status,
        data: result.data || null,
        response: result.response || null
      }, "*");
    } catch(e) {
      console.log("[yt-testing-page] Error:", e.message);
      window.postMessage({
        type: "yt-testing-result",
        videoId: videoId,
        status: 0,
        data: null
      }, "*");
    }
  });

  window.postMessage({ type: "yt-testing-page-ready" }, "*");
  console.log("[yt-testing-page] v10 Ready");
})();
