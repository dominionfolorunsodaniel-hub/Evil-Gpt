// Runs before the page paints so the saved theme never flashes. "auto" (or nothing saved) follows the phone.
(function () {
  var mq = null, root = document.documentElement;
  try { mq = matchMedia("(prefers-color-scheme: light)"); } catch (e) {}
  function mode() { var m = "auto"; try { m = localStorage.getItem("vyra-theme") || "auto"; } catch (e) {} return m === "light" || m === "dark" ? m : "auto"; }
  function effective() { var m = mode(); return m === "auto" ? (mq && mq.matches ? "light" : "dark") : m; }
  function apply() {
    var t = effective(); root.setAttribute("data-theme", t); root.setAttribute("data-theme-mode", mode());
    var meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute("content", t === "light" ? "#f7f4fc" : "#0e0b14");
    try { document.dispatchEvent(new CustomEvent("vyra-theme")); } catch (e) {}
  }
  window.vyraTheme = { mode: mode, apply: apply, set: function (m) { try { if (m === "auto") localStorage.removeItem("vyra-theme"); else localStorage.setItem("vyra-theme", m); } catch (e) {} apply(); } };
  root.setAttribute("data-theme", effective()); root.setAttribute("data-theme-mode", mode());
  if (mq) { var on = function () { if (mode() === "auto") apply(); }; if (mq.addEventListener) mq.addEventListener("change", on); else if (mq.addListener) mq.addListener(on); }
  document.addEventListener("DOMContentLoaded", apply);
})();
