// Runs before the page paints so the saved theme never flashes.
(function () {
  var t = "dark";
  try { t = localStorage.getItem("vyra-theme") || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"); } catch (e) {}
  document.documentElement.setAttribute("data-theme", t);
})();
