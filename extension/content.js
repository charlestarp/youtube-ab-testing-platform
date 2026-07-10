/**
 * YT Testing — Content Script v9 (ISOLATED world)
 * Sends totals snapshot + hourly breakdown to backend.
 * Hourly data lets the backend backfill any missing measurements.
 */

(function() {
  var POLL_INTERVAL = 300000; // 5 minutes
  var collecting = false;
  var backlogDone = {}; // Track which videos have had their full history sent

  console.log("[yt-testing] Content script v9 loaded");

  function showBadge(text, color) {
    var badge = document.getElementById("yt-testing-badge");
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "yt-testing-badge";
      badge.style.cssText = "position:fixed;bottom:10px;right:10px;z-index:99999;padding:8px 14px;border-radius:8px;font-size:12px;font-family:Helvetica,Arial,sans-serif;color:white;pointer-events:none;transition:opacity 0.3s;box-shadow:0 2px 8px rgba(0,0,0,0.3);max-width:350px;word-wrap:break-word;";
      document.body.appendChild(badge);
    }
    badge.style.backgroundColor = color || "#7c63ff";
    badge.textContent = text;
    badge.style.opacity = "1";
    clearTimeout(badge._fadeTimer);
    badge._fadeTimer = setTimeout(function() { badge.style.opacity = "0"; }, 5000);
  }

  function bgMessage(msg) {
    return new Promise(function(resolve) {
      try {
        chrome.runtime.sendMessage(msg, function(response) {
          if (chrome.runtime.lastError) {
            console.log("[yt-testing] Background error:", chrome.runtime.lastError.message);
            resolve(null);
          } else {
            resolve(response);
          }
        });
      } catch(e) {
        resolve(null);
      }
    });
  }

  function getVideoData(videoId) {
    return new Promise(function(resolve) {
      var timeout = setTimeout(function() {
        window.removeEventListener("message", handler);
        resolve(null);
      }, 15000);

      function handler(event) {
        if (event.source !== window || !event.data) return;
        if (event.data.type !== "yt-testing-result") return;
        if (event.data.videoId !== videoId) return;

        window.removeEventListener("message", handler);
        clearTimeout(timeout);

        if (event.data.status !== 200) {
          console.log("[yt-testing] API status", event.data.status, "for", videoId);
          resolve(null);
          return;
        }

        resolve(event.data.data || null);
      }

      window.addEventListener("message", handler);
      window.postMessage({ type: "yt-testing-fetch", videoId: videoId }, "*");
    });
  }

  async function collectData() {
    if (collecting) return;
    collecting = true;

    showBadge("YT Testing: connecting...", "#666");

    var hasSession = await bgMessage({ type: "getSession" });
    if (!hasSession) {
      showBadge("YT Testing: sign in at app.example.com", "#e74c3c");
      collecting = false;
      return;
    }

    var videos = await bgMessage({ type: "getVideos" });
    if (!videos || videos.length === 0) {
      showBadge("YT Testing: no active tests", "#666");
      collecting = false;
      return;
    }

    showBadge("YT Testing: checking " + videos.length + " video" + (videos.length > 1 ? "s" : "") + "...", "#7c63ff");

    var success = 0;
    for (var i = 0; i < videos.length; i++) {
      var video = videos[i];
      var label = video.title || video.video_id;
      if (label.length > 40) label = label.substring(0, 37) + "...";
      showBadge("YT Testing: " + (i + 1) + "/" + videos.length + " " + label, "#7c63ff");

      var data = await getVideoData(video.video_id);
      if (!data) {
        console.log("[yt-testing] No data for", video.video_id);
        if (i < videos.length - 1) await new Promise(function(r) { setTimeout(r, 500); });
        continue;
      }

      // Send totals snapshot
      if (data.totals && (data.totals.impressions > 0 || data.totals.views > 0)) {
        var ok = await bgMessage({
          type: "postSnapshot",
          data: {
            video_id: video.video_id,
            views: data.totals.views,
            impressions: data.totals.impressions,
            ctr: data.totals.ctr,
            watch_time_hours: data.totals.watch_time_hours,
            avg_view_duration_sec: data.totals.avg_view_duration_sec,
            avg_view_pct: data.avgPercentageWatched || 0,
            likes: 0,
            subscribers_net: data.totals.subscribers_net,
            retention_values: data.retentionValues || null
          }
        });
        if (ok) success++;
        console.log("[yt-testing] Snapshot:", video.video_id, "imp=" + data.totals.impressions, "views=" + data.totals.views, "retention=" + (data.retentionValues ? data.retentionValues.length + "pts" : "none"));
      }

      // Send hourly breakdown every poll cycle — the backend deduplicates and
      // only updates settled slots (>2h old), so frequent sends are safe.
      if (data.hourlyMetrics && data.timeSeriesTimestamps && data.timeSeriesTimestamps.length > 0) {
        // Data is CUMULATIVE — compute per-hour deltas
        // Group data points into hour buckets, take last value per bucket
        var metricNames = Object.keys(data.hourlyMetrics);
        var hourLastValues = {}; // { hourKey: { metric: lastCumulativeValue } }

        for (var ti = 0; ti < data.timeSeriesTimestamps.length; ti++) {
          var ts = data.timeSeriesTimestamps[ti];
          var hourKey = new Date(Math.floor(ts / 3600000) * 3600000).toISOString();

          if (!hourLastValues[hourKey]) hourLastValues[hourKey] = {};
          for (var mi2 = 0; mi2 < metricNames.length; mi2++) {
            var mn = metricNames[mi2];
            var val = data.hourlyMetrics[mn][ti];
            if (val !== undefined) {
              // For VTR: only update if non-zero (YouTube returns 0 for sparse minute-level data)
              if (mn === "VIDEO_THUMBNAIL_IMPRESSIONS_VTR") {
                if (val > 0) hourLastValues[hourKey][mn] = val;
              } else {
                hourLastValues[hourKey][mn] = val;
              }
            }
          }
        }

        // Carry forward last known VTR across all hours (YouTube only provides VTR sparsely)
        var lastKnownVTR = 0;
        for (var hfi = 0; hfi < Object.keys(hourLastValues).sort().length; hfi++) {
          var hfKey = Object.keys(hourLastValues).sort()[hfi];
          var vtrVal = hourLastValues[hfKey]["VIDEO_THUMBNAIL_IMPRESSIONS_VTR"];
          if (vtrVal && vtrVal > 0) {
            lastKnownVTR = vtrVal;
          } else {
            hourLastValues[hfKey]["VIDEO_THUMBNAIL_IMPRESSIONS_VTR"] = lastKnownVTR;
          }
        }

        // Compute deltas between consecutive hours
        var hourKeys = Object.keys(hourLastValues).sort();
        var hourlyTimestamps = [];
        var hourlyMetricsAgg = {};
        for (var mi3 = 0; mi3 < metricNames.length; mi3++) {
          hourlyMetricsAgg[metricNames[mi3]] = [];
        }

        for (var hi = 1; hi < hourKeys.length; hi++) {
          var prevHour = hourLastValues[hourKeys[hi - 1]];
          var currHour = hourLastValues[hourKeys[hi]];
          hourlyTimestamps.push(new Date(hourKeys[hi]).getTime());

          for (var mi4 = 0; mi4 < metricNames.length; mi4++) {
            var mn2 = metricNames[mi4];
            var prev = prevHour[mn2] || 0;
            var curr = currHour[mn2] || 0;

            if (mn2 === "VIDEO_THUMBNAIL_IMPRESSIONS_VTR") {
              // Compute per-hour CTR from cumulative clicks
              // VTR values may be fractions (0.08) or percentages (8.0)
              var prevImp = prevHour["VIDEO_THUMBNAIL_IMPRESSIONS"] || 0;
              var currImp = currHour["VIDEO_THUMBNAIL_IMPRESSIONS"] || 0;
              // Detect format: if value < 1, it's a fraction; if > 1, it's a percentage
              var prevRate = prev > 1 ? prev / 100 : prev;
              var currRate = curr > 1 ? curr / 100 : curr;
              var prevClicks = prevImp * prevRate;
              var currClicks = currImp * currRate;
              var hourClicks = Math.max(0, currClicks - prevClicks);
              var hourImp = Math.max(0, currImp - prevImp);
              var hourCtr = hourImp > 0 ? Math.round((hourClicks / hourImp) * 10000) / 100 : 0;
              if (hi === 1) console.log("[yt-testing] CTR debug: prevVTR=" + prev + " currVTR=" + curr + " prevImp=" + prevImp + " currImp=" + currImp + " hourClicks=" + hourClicks.toFixed(1) + " hourCtr=" + hourCtr);
              hourlyMetricsAgg[mn2].push(hourCtr);
            } else if (mn2 === "AVERAGE_WATCH_TIME") {
              // AVD: take the current value (not a delta)
              hourlyMetricsAgg[mn2].push(curr);
            } else {
              // Count metrics: compute delta
              hourlyMetricsAgg[mn2].push(Math.max(0, curr - prev));
            }
          }
        }

        // Override ALL metrics with Reach tab data using YouTube's hour boundaries
        // YouTube buckets by publish time (e.g., 19:00:38), not UTC hours (19:00:00)
        // Use the CTR timestamps as the authoritative hour boundaries
        if (data.reachCumulative && data.reachCumulative["VIDEO_THUMBNAIL_IMPRESSIONS"] && data.reachHourly && data.reachHourly["VIDEO_THUMBNAIL_IMPRESSIONS_VTR"]) {
          var reachImpData = data.reachCumulative["VIDEO_THUMBNAIL_IMPRESSIONS"];
          var reachViewData = data.reachCumulative["EXTERNAL_VIEWS"];
          var reachWtData = data.reachCumulative["EXTERNAL_WATCH_TIME"];
          var ctrTimestamps = data.reachHourly["VIDEO_THUMBNAIL_IMPRESSIONS_VTR"].timestamps;

          // For each CTR hour boundary, find the closest cumulative value
          function getCumValueAt(cumData, targetTs) {
            if (!cumData) return 0;
            var best = 0;
            for (var ci3 = 0; ci3 < cumData.timestamps.length; ci3++) {
              if (cumData.timestamps[ci3] <= targetTs) best = cumData.values[ci3] || 0;
              else break;
            }
            return best;
          }

          // Rebuild hourly data using YouTube's hour boundaries
          var newTimestamps = [];
          var newImp = [];
          var newViews = [];
          var newWt = [];
          for (var rhi = 1; rhi < ctrTimestamps.length; rhi++) {
            var prevTs = ctrTimestamps[rhi - 1];
            var currTs = ctrTimestamps[rhi];
            newTimestamps.push(currTs);
            newImp.push(Math.max(0, getCumValueAt(reachImpData, currTs) - getCumValueAt(reachImpData, prevTs)));
            newViews.push(Math.max(0, getCumValueAt(reachViewData, currTs) - getCumValueAt(reachViewData, prevTs)));
            newWt.push(Math.max(0, getCumValueAt(reachWtData, currTs) - getCumValueAt(reachWtData, prevTs)));
          }

          // Replace our hourly data entirely with reach-aligned data
          hourlyTimestamps = newTimestamps;
          hourlyMetricsAgg["VIDEO_THUMBNAIL_IMPRESSIONS"] = newImp;
          hourlyMetricsAgg["EXTERNAL_VIEWS"] = newViews;
          if (hourlyMetricsAgg["EXTERNAL_WATCH_TIME"]) hourlyMetricsAgg["EXTERNAL_WATCH_TIME"] = newWt;

          console.log("[yt-testing] Rebuilt with reach boundaries:", newTimestamps.length, "hours, first imp=" + newImp[0] + " views=" + newViews[0]);
        }

        // Override CTR with exact per-hour values from Reach tab (non-cumulative)
        if (data.reachHourly && data.reachHourly["VIDEO_THUMBNAIL_IMPRESSIONS_VTR"]) {
          var reachCtr = data.reachHourly["VIDEO_THUMBNAIL_IMPRESSIONS_VTR"];
          // Map reach hourly CTR to our hourly buckets by matching timestamps
          var reachMap = {};
          for (var ri = 0; ri < reachCtr.timestamps.length; ri++) {
            var rKey = new Date(Math.floor(reachCtr.timestamps[ri] / 3600000) * 3600000).getTime();
            reachMap[rKey] = reachCtr.values[ri];
          }
          // Replace computed CTR with exact reach CTR
          for (var hi2 = 0; hi2 < hourlyTimestamps.length; hi2++) {
            var hKey = new Date(Math.floor(hourlyTimestamps[hi2] / 3600000) * 3600000).getTime();
            if (reachMap[hKey] !== undefined) {
              hourlyMetricsAgg["VIDEO_THUMBNAIL_IMPRESSIONS_VTR"][hi2] = reachMap[hKey];
            }
          }
          console.log("[yt-testing] CTR overridden with", Object.keys(reachMap).length, "exact reach values");
        }

        await bgMessage({
          type: "postHourly",
          data: {
            video_id: video.video_id,
            timestamps: hourlyTimestamps,
            metrics: hourlyMetricsAgg
          }
        });
        console.log("[yt-testing] Hourly: sent", hourKeys.length, "hourly buckets x", metricNames.length, "metrics for", video.video_id);
      }

      if (i < videos.length - 1) await new Promise(function(r) { setTimeout(r, 500); });
    }

    showBadge("YT Testing: " + success + "/" + videos.length + " updated", success > 0 ? "#27ae60" : "#e67e22");
    collecting = false;
  }

  // Listen for reach data intercepted by page-script.js when user browses reach tab
  window.addEventListener("message", function(event) {
    if (event.source !== window || !event.data) return;
    if (event.data.type !== "yt-testing-reach-data") return;

    // Extract video ID from current URL
    var match = window.location.pathname.match(/\/video\/([^\/]+)/);
    if (!match) return;
    var videoId = match[1];

    var data = event.data.data;
    if (!data || !data.cards) return;

    // Extract per-hour CTR and cumulative impressions/views from reach cards
    var reachHourly = {};
    var reachCumulative = {};
    for (var ci = 0; ci < data.cards.length; ci++) {
      var card = data.cards[ci];
      if (!card.keyMetricCardData || !card.keyMetricCardData.keyMetricTabs) continue;
      for (var ti = 0; ti < card.keyMetricCardData.keyMetricTabs.length; ti++) {
        var tab = card.keyMetricCardData.keyMetricTabs[ti];
        var series = tab.primaryContent && tab.primaryContent.mainSeries;
        var metric = tab.primaryContent && tab.primaryContent.metric;
        if (!series || !series.datums || !metric) continue;

        if (!series.isCumulative && series.timeUnit === "TIME_PERIOD_UNIT_NTH_HOURS") {
          reachHourly[metric] = { timestamps: [], values: [] };
          for (var di = 0; di < series.datums.length; di++) {
            reachHourly[metric].timestamps.push(series.datums[di].x);
            reachHourly[metric].values.push(series.datums[di].y || 0);
          }
        } else if (series.isCumulative) {
          reachCumulative[metric] = { timestamps: [], values: [] };
          for (var di2 = 0; di2 < series.datums.length; di2++) {
            reachCumulative[metric].timestamps.push(series.datums[di2].x);
            reachCumulative[metric].values.push(series.datums[di2].y || 0);
          }
        }
      }
    }

    if (!reachCumulative["VIDEO_THUMBNAIL_IMPRESSIONS"] || !reachHourly["VIDEO_THUMBNAIL_IMPRESSIONS_VTR"]) return;

    // Build hourly deltas from cumulative data, using CTR timestamps as hour boundaries
    var ctrTs = reachHourly["VIDEO_THUMBNAIL_IMPRESSIONS_VTR"].timestamps;
    var impData = reachCumulative["VIDEO_THUMBNAIL_IMPRESSIONS"];
    var viewData = reachCumulative["EXTERNAL_VIEWS"];
    var wtData = reachCumulative["EXTERNAL_WATCH_TIME"];

    function getCumAt(cumData, targetTs) {
      if (!cumData) return 0;
      var best = 0;
      for (var i = 0; i < cumData.timestamps.length; i++) {
        if (cumData.timestamps[i] <= targetTs) best = cumData.values[i] || 0;
        else break;
      }
      return best;
    }

    var timestamps = [];
    var metrics = {
      VIDEO_THUMBNAIL_IMPRESSIONS: [],
      VIDEO_THUMBNAIL_IMPRESSIONS_VTR: reachHourly["VIDEO_THUMBNAIL_IMPRESSIONS_VTR"].values.slice(1),
      EXTERNAL_VIEWS: [],
      EXTERNAL_WATCH_TIME: []
    };

    for (var i = 1; i < ctrTs.length; i++) {
      timestamps.push(ctrTs[i]);
      metrics.VIDEO_THUMBNAIL_IMPRESSIONS.push(Math.max(0, getCumAt(impData, ctrTs[i]) - getCumAt(impData, ctrTs[i-1])));
      metrics.EXTERNAL_VIEWS.push(Math.max(0, getCumAt(viewData, ctrTs[i]) - getCumAt(viewData, ctrTs[i-1])));
      if (wtData) metrics.EXTERNAL_WATCH_TIME.push(Math.max(0, getCumAt(wtData, ctrTs[i]) - getCumAt(wtData, ctrTs[i-1])));
    }

    console.log("[yt-testing] Reach intercept: " + videoId + " " + timestamps.length + " hours with real CTR");
    showBadge("YT Testing: reach data for " + videoId.substring(0, 8) + "...", "#27ae60");

    bgMessage({
      type: "postHourly",
      data: { video_id: videoId, timestamps: timestamps, metrics: metrics }
    });
  });

  // Also fetch data for whatever video is currently open in Studio
  // This handles videos not in the poll list (completed tests, manual browsing)
  async function collectCurrentVideo() {
    var match = window.location.pathname.match(/\/video\/([^\/]+)/);
    if (!match) return;
    var videoId = match[1];

    var hasSession = await bgMessage({ type: "getSession" });
    if (!hasSession) return;

    var data = await getVideoData(videoId);
    if (!data) return;

    // Send snapshot
    if (data.totals && (data.totals.impressions > 0 || data.totals.views > 0)) {
      await bgMessage({
        type: "postSnapshot",
        data: {
          video_id: videoId,
          views: data.totals.views,
          impressions: data.totals.impressions,
          ctr: data.totals.ctr,
          watch_time_hours: data.totals.watch_time_hours,
          avg_view_duration_sec: data.totals.avg_view_duration_sec,
          avg_view_pct: data.avgPercentageWatched || 0,
          likes: 0,
          subscribers_net: data.totals.subscribers_net,
          retention_values: data.retentionValues || null
        }
      });
    }

    // Send hourly + reach data
    if (data.hourlyMetrics && data.timeSeriesTimestamps && data.timeSeriesTimestamps.length > 0) {
      // Reuse the same delta computation from collectData
      // For simplicity, just send the raw data and let the server handle it
      var metricNames = Object.keys(data.hourlyMetrics);
      var hourLastValues = {};
      for (var ti = 0; ti < data.timeSeriesTimestamps.length; ti++) {
        var ts = data.timeSeriesTimestamps[ti];
        var hourKey = new Date(Math.floor(ts / 3600000) * 3600000).toISOString();
        if (!hourLastValues[hourKey]) hourLastValues[hourKey] = {};
        for (var mi = 0; mi < metricNames.length; mi++) {
          var mn = metricNames[mi];
          var val = data.hourlyMetrics[mn][ti];
          if (val !== undefined) {
            if (mn === "VIDEO_THUMBNAIL_IMPRESSIONS_VTR") {
              if (val > 0) hourLastValues[hourKey][mn] = val;
            } else {
              hourLastValues[hourKey][mn] = val;
            }
          }
        }
      }
      var hourKeys = Object.keys(hourLastValues).sort();
      var hourlyTimestamps = [];
      var hourlyMetrics = {};
      for (var mi2 = 0; mi2 < metricNames.length; mi2++) hourlyMetrics[metricNames[mi2]] = [];
      for (var hi = 1; hi < hourKeys.length; hi++) {
        var prev = hourLastValues[hourKeys[hi - 1]];
        var curr = hourLastValues[hourKeys[hi]];
        hourlyTimestamps.push(new Date(hourKeys[hi]).getTime());
        for (var mi3 = 0; mi3 < metricNames.length; mi3++) {
          var mn2 = metricNames[mi3];
          if (mn2 === "VIDEO_THUMBNAIL_IMPRESSIONS_VTR") {
            var prevImp = prev["VIDEO_THUMBNAIL_IMPRESSIONS"] || 0;
            var currImp = curr["VIDEO_THUMBNAIL_IMPRESSIONS"] || 0;
            var prevRate = (prev[mn2] || 0) > 1 ? (prev[mn2] || 0) / 100 : (prev[mn2] || 0);
            var currRate = (curr[mn2] || 0) > 1 ? (curr[mn2] || 0) / 100 : (curr[mn2] || 0);
            var hourClicks = Math.max(0, currImp * currRate - prevImp * prevRate);
            var hourImpD = Math.max(0, currImp - prevImp);
            hourlyMetrics[mn2].push(hourImpD > 0 ? Math.round((hourClicks / hourImpD) * 10000) / 100 : 0);
          } else if (mn2 === "AVERAGE_WATCH_TIME") {
            hourlyMetrics[mn2].push(curr[mn2] || 0);
          } else {
            hourlyMetrics[mn2].push(Math.max(0, (curr[mn2] || 0) - (prev[mn2] || 0)));
          }
        }
      }

      // Override with reach data if available
      if (data.reachCumulative && data.reachHourly && data.reachHourly["VIDEO_THUMBNAIL_IMPRESSIONS_VTR"]) {
        var ctrTs = data.reachHourly["VIDEO_THUMBNAIL_IMPRESSIONS_VTR"].timestamps;
        var impData = data.reachCumulative["VIDEO_THUMBNAIL_IMPRESSIONS"];
        var viewData = data.reachCumulative["EXTERNAL_VIEWS"];
        function getCumAt(cumData, targetTs) {
          if (!cumData) return 0;
          var best = 0;
          for (var ci = 0; ci < cumData.timestamps.length; ci++) {
            if (cumData.timestamps[ci] <= targetTs) best = cumData.values[ci] || 0; else break;
          }
          return best;
        }
        var newTs = [], newImp = [], newViews = [];
        for (var ri = 1; ri < ctrTs.length; ri++) {
          newTs.push(ctrTs[ri]);
          newImp.push(Math.max(0, getCumAt(impData, ctrTs[ri]) - getCumAt(impData, ctrTs[ri-1])));
          newViews.push(Math.max(0, getCumAt(viewData, ctrTs[ri]) - getCumAt(viewData, ctrTs[ri-1])));
        }
        hourlyTimestamps = newTs;
        hourlyMetrics["VIDEO_THUMBNAIL_IMPRESSIONS"] = newImp;
        hourlyMetrics["EXTERNAL_VIEWS"] = newViews;
        hourlyMetrics["VIDEO_THUMBNAIL_IMPRESSIONS_VTR"] = data.reachHourly["VIDEO_THUMBNAIL_IMPRESSIONS_VTR"].values.slice(1);
      }

      if (hourlyTimestamps.length > 0) {
        await bgMessage({ type: "postHourly", data: { video_id: videoId, timestamps: hourlyTimestamps, metrics: hourlyMetrics } });
        console.log("[yt-testing] Current video " + videoId + ": sent " + hourlyTimestamps.length + " hours");
        showBadge("YT Testing: " + videoId.substring(0, 8) + " data sent", "#27ae60");
      }
    }
  }

  setTimeout(collectData, 3000);
  setInterval(collectData, POLL_INTERVAL);
  // Also collect current video on load and periodically
  setTimeout(collectCurrentVideo, 5000);
  setInterval(collectCurrentVideo, POLL_INTERVAL);
})();
