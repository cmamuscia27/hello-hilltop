(function () {
  var SITEKEY = "0x4AAAAAAFw3k6QKRDwZ1bZ4";
  var widgets = {};
  var widgetErrors = {};
  var okDefaults = {
    "signup-form": "You're on the list! Hello, neighbor! 🧡",
    "ideas-form": "Got it! Every idea gets read. Thank you! 💡",
    "directory-form": "Got it! We'll look it over before it goes on the directory.",
    "removal-form": "Got it. We'll take that listing down as soon as we can.",
    "host-form": "Thanks! We'll read this before it goes on the calendar.",
  };

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

  // Called by the Turnstile api.js onload query param. Forms stay on the page
  // after submit, so each widget id is kept and reset after every attempt.
  window.onHilltopTurnstileLoad = function () {
    if (!window.turnstile) return;
    document.querySelectorAll("form[data-turnstile-action]").forEach(function (form) {
      var el = form.querySelector(".turnstile");
      var action = form.getAttribute("data-turnstile-action");
      if (!el || !action || widgets[form.id]) return;
      widgets[form.id] = turnstile.render(el, widgetOptions(action));
    });
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

  function emailOk(value) {
    return /^\S+@\S+\.\S{2,}$/.test(value);
  }

  function problem(form) {
    var email = form.querySelector("input[name=email]");
    var idea = form.querySelector("textarea[name=idea]");
    if (email && email.required && !email.value.trim()) return ["Please add your email.", email];
    if (email && email.value.trim() && !emailOk(email.value.trim())) return ["That email doesn't look quite right.", email];
    if (idea && idea.value.trim().length < 3) return ["Tell us a little more about your idea.", idea];
    if (form.id === "directory-form") {
      var category = form.querySelector("[name=category]");
      var title = form.querySelector("[name=title]");
      var description = form.querySelector("[name=description]");
      var contact = form.querySelector("[name=contact]");
      var consent = form.querySelector("[name=consent]");
      if (!category.value) return ["Choose a category.", category];
      if (title.value.trim().length < 3) return ["Add a name for the listing.", title];
      if (description.value.trim().length < 3) return ["Tell neighbors a little more.", description];
      if (contact.value.trim().length < 3) return ["Add the contact info you want to share.", contact];
      if (!consent.checked) return ["Check the box so we know you're okay with a public listing.", consent];
    }
    if (form.id === "removal-form") {
      var listing = form.querySelector("[name=listing]");
      var confirmBox = form.querySelector("[name=confirm]");
      if (listing.value.trim().length < 2) return ["Tell us which listing to take down.", listing];
      if (!confirmBox.checked) return ["Check the box so we know you want it taken down.", confirmBox];
    }
    if (form.id === "host-form") {
      var hostTitle = form.querySelector("[name=title]");
      var start = form.querySelector("[name=starts_at]");
      var where = form.querySelector("[name=location]");
      var about = form.querySelector("[name=description]");
      var hostName = form.querySelector("[name=name]");
      if (hostTitle.value.trim().length < 3) return ["Add an event title.", hostTitle];
      if (!start.value) return ["Add a Denver start time.", start];
      if (where.value.trim().length < 2) return ["Add a location.", where];
      if (about.value.trim().length < 3) return ["Add a short description.", about];
      if (hostName.value.trim().length < 2) return ["Add your name.", hostName];
    }
    return null;
  }

  function setup(id) {
    var form = document.getElementById(id);
    if (!form) return;
    var msg = form.querySelector(".form-msg");
    var btn = form.querySelector("button[type=submit]");
    var action = form.getAttribute("data-turnstile-action") || "";
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      msg.className = "form-msg";
      var found = problem(form);
      if (found) { show(false, found[0]); if (found[1]) found[1].focus(); return; }
      var token = turnstileToken(id);
      if (!token) {
        show(false, widgetErrors[action]
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
          if (res.ok) { form.reset(); show(true, res.message || okDefaults[id]); }
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

  Object.keys(okDefaults).forEach(function (id) { setup(id); });

  document.querySelectorAll(".ig-photo img").forEach(function (img) {
    img.addEventListener("error", function () {
      var photo = img.closest(".ig-photo");
      if (photo) photo.classList.add("ig-photo-missing");
      img.remove();
    });
  });

  var thanksCopy = {
    signup: "You're on the list! Hello, neighbor! 🧡",
    ideas: "Got it! Every idea gets read. Thank you! 💡",
    directory: "Got it! We'll look it over before it goes on the directory.",
    removal: "Got it. We'll take that listing down as soon as we can.",
    host: "Thanks! We'll read this before it goes on the calendar.",
  };
  var params = new URLSearchParams(location.search);
  var thanks = params.get("thanks");
  var errored = params.get("error");
  var key = thanks || errored;
  if (key && thanksCopy[key]) {
    var noted = document.getElementById(key + "-form");
    if (noted) {
      var note = noted.querySelector(".form-msg");
      note.textContent = thanks ? thanksCopy[key] : "Hmm, something was missing. Please check the form and try again.";
      note.className = "form-msg " + (thanks ? "ok" : "err");
    }
  }
})();
