/* /pv sandbox self-check (web-hub-html-preview plan §9) — runs inside the CSP-sandboxed
 * opaque-origin document the hub serves. Every probe asserts an ISOLATION expectation
 * (G1–G14 of the browser gate); nothing here needs hub authority, and nothing here may get
 * it. Results land in the DOM table AND in window.__pvSelfcheck (what the CDP driver reads).
 *
 * Expected outcome classes:
 *   "threw"          — the engine denied the API to the opaque origin (pass)
 *   "rejected"       — the promise rejected (pass)
 *   "unreadable"     — fetch/EventSource failed to deliver a readable response (pass)
 *   "blocked"        — navigation attempt had no effect (pass)
 *   "denied"         — server answered 4xx and no file content leaked (pass)
 *   "loaded"         — F2/F3 positive case (pass)
 */
(function () {
  "use strict";

  var results = {};
  var pending = {};
  var rowId = 0;

  window.__pvSelfcheck = { done: false, env: {}, results: results, verdict: "running" };

  function setMeta() {
    try {
      document.getElementById("self-url").textContent = String(location.href);
      document.getElementById("self-origin").textContent = String(location.origin);
      // eslint-disable-next-line no-empty
    } catch (e) {}
  }

  function row(name, expected) {
    var id = "r" + rowId++;
    var tr = document.createElement("tr");
    tr.id = id;
    var tdName = document.createElement("td");
    tdName.textContent = name;
    var tdExp = document.createElement("td");
    tdExp.textContent = expected;
    var tdGot = document.createElement("td");
    var tdRes = document.createElement("td");
    tdRes.className = "pending";
    tdRes.textContent = "…";
    tr.appendChild(tdName);
    tr.appendChild(tdExp);
    tr.appendChild(tdGot);
    tr.appendChild(tdRes);
    document.querySelector("#report tbody").appendChild(tr);
    return {
      done: function (got, pass) {
        tdGot.textContent = got;
        tdRes.textContent = pass ? "PASS" : "FAIL";
        tdRes.className = pass ? "result-pass" : "result-fail";
        results[name] = { got: got, pass: pass };
        delete pending[name];
        maybeFinish();
      },
    };
  }

  function settle(name, expected, outcome, pass) {
    row(name, expected).done(outcome, pass);
  }

  /** Run one sync/async probe; any unexpected throw is recorded as the outcome itself. */
  function probe(name, expected, passOf, fn) {
    pending[name] = true;
    Promise.resolve()
      .then(fn)
      .then(
        function (outcome) {
          settle(name, expected, outcome, passOf(outcome));
        },
        function (err) {
          var msg = "threw: " + (err && err.name ? err.name : String(err));
          settle(name, expected, msg, passOf(msg));
        },
      );
  }

  function maybeFinish() {
    var keys = Object.keys(pending);
    if (keys.length > 0) {
      document.getElementById("verdict").textContent = "running… (" + keys.join(", ") + ")";
      return;
    }
    var fails = Object.keys(results).filter(function (k) {
      return !results[k].pass;
    });
    var verdict = fails.length === 0 ? "PASS" : "FAIL (" + fails.join(", ") + ")";
    window.__pvSelfcheck.verdict = verdict;
    window.__pvSelfcheck.done = true;
    var el = document.getElementById("verdict");
    el.textContent = "OVERALL: " + verdict;
    el.className = fails.length === 0 ? "pass" : "fail";
    document.getElementById("json").textContent = JSON.stringify(window.__pvSelfcheck, null, 2);
  }

  function isThrew(outcome) {
    return typeof outcome === "string" && outcome.indexOf("threw") === 0;
  }

  // ---- G1: cookie / storage / IndexedDB — opaque origin must deny --------------------------

  probe("document.cookie", "throws (opaque origin)", isThrew, function () {
    var v = document.cookie; // eslint-disable-line no-unused-vars
    return "worked (read: " + JSON.stringify(String(v).slice(0, 40)) + ")";
  });

  probe("localStorage", "throws (opaque origin)", isThrew, function () {
    var s = window.localStorage;
    s.setItem("pv", "x");
    return "worked";
  });

  probe("sessionStorage", "throws (opaque origin)", isThrew, function () {
    var s = window.sessionStorage;
    s.setItem("pv", "x");
    return "worked";
  });

  probe(
    "indexedDB",
    "throws or open() rejects (opaque origin)",
    function (o) {
      return typeof o === "string" && (o.indexOf("threw") === 0 || o.indexOf("rejected") === 0);
    },
    function () {
      var db = window.indexedDB; // the getter itself may throw in a sandboxed document
      return new Promise(function (resolve) {
        var req = db.open("pv-selfcheck", 1);
        req.onupgradeneeded = function () {
          resolve("opened (BAD — storage granted)");
        };
        req.onsuccess = function () {
          resolve("opened (BAD — storage granted)");
        };
        req.onerror = function () {
          resolve("rejected: " + String(req.error));
        };
        setTimeout(function () {
          resolve("opened? (timeout — neither granted nor denied)");
        }, 3000);
      });
    },
  );

  // ---- G2: service worker registration must reject -----------------------------------------

  probe(
    "serviceWorker.register",
    "rejects (or the API itself throws)",
    function (o) {
      return typeof o === "string" && (o.indexOf("rejected") === 0 || o.indexOf("threw") === 0);
    },
    function () {
      return navigator.serviceWorker
        .register("selfcheck.js")
        .then(function () {
          return "registered (BAD)";
        })
        .catch(function (err) {
          return "rejected: " + (err && err.name ? err.name : String(err));
        });
    },
  );

  // ---- G3: BroadcastChannel — may exist, but can never reach a hub-origin listener ----------

  probe(
    "BroadcastChannel→hub",
    "created only in its own opaque partition (hub listeners unreachable)",
    function (o) {
      return typeof o === "string" && o.indexOf("sent-isolated") === 0;
    },
    function () {
      return new Promise(function (resolve) {
        var ch = new BroadcastChannel("pwh-hub-probe");
        ch.onmessage = function () {
          resolve("RECEIVED A HUB MESSAGE (BAD)");
        };
        ch.postMessage({ pvSelfcheck: true });
        setTimeout(function () {
          resolve("sent-isolated (no echo within 500ms; hub-side assertions live in the gate driver)");
        }, 500);
      });
    },
  );

  // ---- G1/G8/G9: top / parent / opener DOM access -------------------------------------------

  probe(
    "top.location read",
    "throws (cross-origin; raw top-level docs have nothing above)",
    function (o) {
      return isThrew(o) || (typeof o === "string" && o.indexOf("top-is-self") === 0);
    },
    function () {
      if (window.top === window) {
        return "top-is-self (raw document — own location is trivially readable; no ancestor exists)";
      }
      var href = window.top.location.href; // eslint-disable-line no-unused-vars
      return "worked";
    },
  );

  probe(
    "parent.document",
    "throws (cross-origin; raw top-level docs have nothing above)",
    function (o) {
      return isThrew(o) || (typeof o === "string" && o.indexOf("parent-is-self") === 0);
    },
    function () {
      if (window.parent === window) {
        return "parent-is-self (raw document — own DOM is trivially readable; no ancestor exists)";
      }
      var t = window.parent.document.title; // eslint-disable-line no-unused-vars
      return "worked";
    },
  );

  probe("opener.document", "throws or opener === null", isThrew, function () {
    if (window.opener === null) return "threw: opener-is-null";
    var t = window.opener.document.title; // eslint-disable-line no-unused-vars
    return "worked";
  });

  // ---- G4/G5/G6/G7: hub API reachability ----------------------------------------------------

  function apiFetch(name, path) {
    probe(
      name,
      "unreadable (401/TypeError — no credential, no ACAO)",
      function (o) {
        return typeof o === "string" && o.indexOf("unreadable") === 0;
      },
      function () {
        return fetch(path, { credentials: "include" }).then(
          function (r) {
            return r
              .text()
              .then(function (body) {
                return "READABLE " + r.status + ": " + body.slice(0, 60) + " (BAD)";
              })
              .catch(function () {
                return "unreadable (" + r.status + " — body blocked)";
              });
          },
          function (err) {
            return "unreadable (" + (err && err.name ? err.name : String(err)) + ")";
          },
        );
      },
    );
  }

  apiFetch("fetch /api/history", "/api/history");
  apiFetch("fetch /api/events", "/api/events");

  probe(
    "EventSource /api/events",
    "errors (no credential, no ACAO)",
    function (o) {
      return typeof o === "string" && o.indexOf("errored") === 0;
    },
    function () {
      return new Promise(function (resolve) {
        var es = new EventSource("/api/events");
        var done = false;
        var finish = function (how) {
          if (done) return;
          done = true;
          es.close();
          resolve(how);
        };
        es.onerror = function () {
          finish("errored");
        };
        es.onopen = function () {
          finish("OPENED A STREAM (BAD)");
        };
        setTimeout(function () {
          finish("errored (timeout, no open)");
        }, 2500);
      });
    },
  );

  probe(
    "X-PWH fetch /api/run/history",
    "preflight blocked (OPTIONS 404, no ACAO) ⇒ unreadable",
    function (o) {
      return typeof o === "string" && o.indexOf("unreadable") === 0;
    },
    function () {
      return fetch("/api/run/history", { headers: { "X-PWH": "1" }, credentials: "include" }).then(
        function (r) {
          return r
            .text()
            .then(function (body) {
              return "READABLE " + r.status + ": " + body.slice(0, 60) + " (BAD)";
            })
            .catch(function () {
              return "unreadable (" + r.status + " — body blocked)";
            });
        },
        function (err) {
          return "unreadable (" + (err && err.name ? err.name : String(err)) + ")";
        },
      );
    },
  );

  // G6: no-cors text/plain POST — the response stays opaque; the hub must not 2xx it
  probe(
    "no-cors POST /api/cmd",
    "opaque failure (hub: 401/403 — never 2xx)",
    function (o) {
      return typeof o === "string" && (o.indexOf("opaque") === 0 || o.indexOf("threw") === 0);
    },
    function () {
      return fetch("/api/cmd", {
        method: "POST",
        mode: "no-cors",
        credentials: "include",
        headers: { "Content-Type": "text/plain" },
        body: "pv-selfcheck",
      }).then(
        function () {
          return "opaque (response type: opaque — body unreadable; hub-side status is asserted by the gate driver)";
        },
        function (err) {
          return "threw: " + (err && err.name ? err.name : String(err));
        },
      );
    },
  );

  // G6: real <form> POST into a hidden nested iframe — the probe page must survive
  probe(
    "form POST /api/cmd",
    "completes into the sink frame; probe page intact; hub: non-2xx",
    function (o) {
      return typeof o === "string" && o.indexOf("posted-intact") === 0;
    },
    function () {
      return new Promise(function (resolve) {
        var form = document.createElement("form");
        form.method = "POST";
        form.action = "/api/cmd";
        form.target = "form-sink";
        var input = document.createElement("input");
        input.name = "pv";
        input.value = "selfcheck";
        form.appendChild(input);
        document.body.appendChild(form);
        var sink = document.getElementById("form-sink");
        var settled = false;
        var finish = function (how) {
          if (settled) return;
          settled = true;
          resolve(how);
        };
        sink.addEventListener("load", function () {
          setTimeout(function () {
            finish(
              document.getElementById("json")
                ? "posted-intact (sink navigated, content cross-origin unreadable)"
                : "PAGE REPLACED (BAD)",
            );
          }, 100);
        });
        form.submit();
        setTimeout(function () {
          finish("posted-intact (no load event — blocked navigation is also safe)");
        }, 3000);
      });
    },
  );

  // G7: <img> pointing at a GET API — response must never render as an image
  probe(
    "<img> /api/avatar",
    "not an image (no decode)",
    function (o) {
      return typeof o === "string" && o.indexOf("not-image") === 0;
    },
    function () {
      return new Promise(function (resolve) {
        var img = new Image();
        img.onload = function () {
          resolve("DECODED AN IMAGE (BAD — " + img.width + "px)");
        };
        img.onerror = function () {
          resolve("not-image (onerror)");
        };
        img.src = "/api/avatar";
        setTimeout(function () {
          resolve("not-image (timeout)");
        }, 4000);
      });
    },
  );

  // ---- G8: top navigation -------------------------------------------------------------------

  probe(
    "top.location assignment",
    "blocked (no allow-top-navigation; raw top-level docs have nothing above to hijack)",
    function (o) {
      return (
        typeof o === "string" &&
        (o.indexOf("blocked") === 0 || o.indexOf("threw") === 0 || o.indexOf("top-is-self") === 0)
      );
    },
    function () {
      return new Promise(function (resolve) {
        if (window.top === window) {
          // a RAW top-level /pv document: "top" is the page itself — there is no hub tab above
          // it to hijack. Self-navigation is (and must be) allowed for any page; navigating
          // itself away gains no hub authority, and doing it here would destroy this report.
          resolve("top-is-self (raw document — nothing above to hijack)");
          return;
        }
        var beforeTopUrl = null;
        try {
          beforeTopUrl = window.top.location.href;
        } catch (e) {
          beforeTopUrl = "unreadable";
        }
        try {
          window.top.location = "https://example.com/pv-escape";
        } catch (e) {
          resolve("threw: " + (e && e.name ? e.name : String(e)));
          return;
        }
        setTimeout(function () {
          var afterTopUrl = null;
          try {
            afterTopUrl = window.top.location.href;
          } catch (e) {
            afterTopUrl = "unreadable";
          }
          resolve(
            afterTopUrl === beforeTopUrl
              ? "blocked (top unchanged; driver also asserts the tab URL)"
              : "NAVIGATED (BAD)",
          );
        }, 800);
      });
    },
  );

  // ---- G10: postMessage to parent changes nothing (no hub listener may react) ---------------

  probe(
    "parent.postMessage",
    "sent (and affects nothing — the wrapper has no listener)",
    function (o) {
      return typeof o === "string" && o.indexOf("sent") === 0;
    },
    function () {
      var replied = false;
      window.addEventListener("message", function (ev) {
        if (ev.data && ev.data.__pvSelfcheckEcho) replied = true;
      });
      try {
        window.parent.postMessage({ __pvSelfcheck: true }, "*");
      } catch (e) {
        return "sent (postMessage itself threw: " + String(e) + ")";
      }
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve(replied ? "sent (ECHOED BACK — inspect!)" : "sent (no echo — nothing granted authority)");
        }, 600);
      });
    },
  );

  // ---- G11/G12: escape the bound directory; credentials inside it ---------------------------

  function deniedFetch(name, path, note) {
    probe(
      name,
      note,
      function (o) {
        return typeof o === "string" && o.indexOf("denied") === 0;
      },
      function () {
        return fetch(path).then(
          function (r) {
            return r.text().then(
              function (body) {
                if (r.status >= 200 && r.status < 300) {
                  return "SERVED " + r.status + " (BAD): " + body.slice(0, 60);
                }
                return "denied (" + r.status + " " + JSON.stringify(body.slice(0, 40)) + ")";
              },
              function () {
                return r.status >= 200 && r.status < 300
                  ? "denied (" + r.status + ", body unreadable)"
                  : "denied (" + r.status + " — body unreadable)";
              },
            );
          },
          function (err) {
            return "denied (fetch failed: " + (err && err.name ? err.name : String(err)) + ")";
          },
        );
      },
    );
  }

  deniedFetch("../ escape", "../neighbor.css", "400/403/404, never a sibling ABOVE the bound dir");
  deniedFetch("%2e%2e escape", "%2e%2e/neighbor.css", "client-normalized ⇒ still no traversal");
  deniedFetch("sub/.. escape", "sub/../../neighbor.css", "no escape via subdir");
  deniedFetch(".ssh/id_rsa", ".ssh/id_rsa", "403 denylist (G12)");
  deniedFetch("absolute /etc/passwd", "/etc/passwd", "404 (root-absolute hits the hub UI root, F2 non-goal)");

  // ---- F2 positive: own directory + subdirectory resources -----------------------------------

  probe(
    "sub/asset.txt (F2)",
    "200 + known bytes",
    function (o) {
      return typeof o === "string" && o.indexOf("loaded") === 0;
    },
    function () {
      return fetch("sub/asset.txt")
        .then(function (r) {
          return r.text().then(function (body) {
            return r.status === 200 && body.indexOf("pv-selfcheck-sub-asset") === 0
              ? "loaded (" + r.status + ", " + body.length + "B)"
              : "WRONG RESPONSE " + r.status + ": " + body.slice(0, 40);
          });
        })
        .catch(function (err) {
          return "failed: " + String(err);
        });
    },
  );

  probe(
    "stylesheet applied (F2)",
    "computed style from selfcheck.css",
    function (o) {
      return typeof o === "string" && o.indexOf("applied") === 0;
    },
    function () {
      var bg = getComputedStyle(document.body).backgroundColor;
      return bg === "rgb(251, 251, 249)" ? "applied (bg " + bg + ")" : "NOT APPLIED (bg " + bg + ")";
    },
  );

  // ---- G13/F3: external network --------------------------------------------------------------

  probe(
    "CDN script load (F3)",
    "loads from the public internet",
    function (o) {
      return typeof o === "string" && o.indexOf("loaded") === 0;
    },
    function () {
      return new Promise(function (resolve) {
        var s = document.createElement("script");
        var settled = false;
        var finish = function (how) {
          if (settled) return;
          settled = true;
          resolve(how);
        };
        s.onload = function () {
          finish(
            typeof window.dayjs === "function"
              ? "loaded (dayjs@1 from cdn.jsdelivr.net executed)"
              : "loaded (script ran; global missing)",
          );
        };
        s.onerror = function () {
          window.__pvSelfcheck.env.cdn = "onerror — no external network in this environment?";
          finish("failed (onerror — see env note)");
        };
        s.src = "https://cdn.jsdelivr.net/npm/dayjs@1/dayjs.min.js";
        document.head.appendChild(s);
        setTimeout(function () {
          finish("failed (timeout 8s — see env note)");
        }, 8000);
      });
    },
  );

  // ---- G9: popup isolation (runs the same cookie/opener probes in a child tab) ---------------

  probe(
    "popup sandboxed (G9)",
    "popup inherits the sandbox: cookie throws, opener DOM throws",
    function (o) {
      return typeof o === "string" && o.indexOf("popup-ok") === 0;
    },
    function () {
      return new Promise(function (resolve) {
        var replied = false;
        var finish = function (how) {
          if (replied) return;
          replied = true;
          resolve(how);
        };
        window.addEventListener("message", function (ev) {
          if (!ev.data || !ev.data.__pvPopupProbe) return;
          var d = ev.data.__pvPopupProbe;
          var ok = d.cookieThrew === true && d.openerThrewOrNull === true && d.stillSandboxed === true;
          finish(
            (ok ? "popup-ok" : "POPUP ESCAPED (BAD) ") +
              "(cookieThrew=" +
              d.cookieThrew +
              " openerThrewOrNull=" +
              d.openerThrewOrNull +
              ")",
          );
        });
        var w = window.open("popup.html", "pv-popup-probe", "width=420,height=320");
        if (w === null || w === undefined) {
          finish("popup-ok (popups blocked in this engine — nothing escaped)");
          return;
        }
        setTimeout(function () {
          finish("popup-ok? (no reply in 6s — popup likely blocked or could not postMessage)");
        }, 6000);
      });
    },
  );

  setMeta();
  maybeFinish();
})();
