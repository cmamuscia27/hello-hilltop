(function () {
  var SITEKEY = "0x4AAAAAAFw3k6QKRDwZ1bZ4";
  var widgets = {};
  var widgetErrors = {};

  function widgetOptions(action) {
    var narrow = window.matchMedia && window.matchMedia("(max-width: 480px)").matches;
    return {
      sitekey: SITEKEY,
      action: action,
      appearance: "interaction-only",
      theme: "light",
      size: narrow ? "compact" : "flexible",
      "error-callback": function () { widgetErrors[action] = true; },
    };
  }

  // Called by the Turnstile api.js onload query param. Both forms stay on the
  // page after submit, so each widget id is kept and reset after every attempt.
  window.onHilltopTurnstileLoad = function () {
    if (!window.turnstile) return;
    widgets["signup-form"] = turnstile.render("#signup-turnstile", widgetOptions("signup"));
    widgets["ideas-form"] = turnstile.render("#ideas-turnstile", widgetOptions("ideas"));
  };

  function turnstileToken(formId) {
    var widgetId = widgets[formId];
    if (window.turnstile && widgetId != null) {
      var fromWidget = turnstile.getResponse(widgetId);
      if (fromWidget) return fromWidget;
    }
    var form = document.getElementById(formId);
    var hidden = form && form.querySelector('input[name="cf-turnstile-response"]');
    return (hidden && hidden.value) || "";
  }

  function resetTurnstile(formId) {
    var widgetId = widgets[formId];
    if (window.turnstile && widgetId != null) {
      try { turnstile.reset(widgetId); } catch (e) { /* widget already gone */ }
    }
  }

  function setup(id, okDefault) {
    var form = document.getElementById(id);
    if (!form) return;
    var msg = form.querySelector(".form-msg");
    var btn = form.querySelector("button[type=submit]");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      msg.className = "form-msg";
      var email = form.querySelector("input[name=email]");
      var idea = form.querySelector("textarea[name=idea]");
      if (email && email.required && !email.value.trim()) { show(false, "Please add your email."); email.focus(); return; }
      if (email && email.value.trim() && !/^\S+@\S+\.\S{2,}$/.test(email.value.trim())) { show(false, "That email doesn't look quite right."); email.focus(); return; }
      if (idea && idea.value.trim().length < 3) { show(false, "Tell us a little more about your idea."); idea.focus(); return; }
      var token = turnstileToken(id);
      if (!token) {
        show(false, widgetErrors[id === "ideas-form" ? "ideas" : "signup"]
          ? "The security check didn't load. Please refresh the page and try again."
          : "Give us a second to check you're a neighbor, then try again.");
        return;
      }
      var data = {};
      new FormData(form).forEach(function (v, k) { data[k] = v; });
      data["cf-turnstile-response"] = token;
      btn.disabled = true;
      fetch(form.action, { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify(data) })
        .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
        .then(function (res) {
          if (res.ok) { form.reset(); show(true, res.message || okDefault); }
          else show(false, res.message || "Hmm, that didn't go through. Please try again.");
        })
        .catch(function () { show(false, "Hmm, that didn't go through. Please try again."); })
        .finally(function () {
          btn.disabled = false;
          resetTurnstile(id);
        });
    });
    function show(ok, text) { msg.textContent = text; msg.className = "form-msg " + (ok ? "ok" : "err"); }
  }
  setup("signup-form", "You're on the list! Hello, neighbor! 🧡");
  setup("ideas-form", "Got it! Every idea gets read. Thank you! 💡");

  // Instagram CDN links expire. A broken photo keeps the post link and a placeholder.
  document.querySelectorAll(".ig-photo img").forEach(function (img) {
    img.addEventListener("error", function () {
      var photo = img.closest(".ig-photo");
      if (photo) photo.classList.add("ig-photo-missing");
      img.remove();
    });
  });

  // Non-JS fallback flags (?thanks=signup / ?error=ideas)
  var p = new URLSearchParams(location.search);
  var t = p.get("thanks"), er = p.get("error");
  var key = t || er;
  if (key) {
    var f = document.getElementById(key === "ideas" ? "ideas-form" : "signup-form");
    if (f) {
      var m = f.querySelector(".form-msg");
      m.textContent = t ? (key === "ideas" ? "Got it! Every idea gets read. Thank you! 💡" : "You're on the list! Hello, neighbor! 🧡") : "Hmm, something was missing. Please check the form and try again.";
      m.className = "form-msg " + (t ? "ok" : "err");
    }
  }
})();
