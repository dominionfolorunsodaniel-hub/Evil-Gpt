// Install-to-home-screen support and offline shell.
window.vyraInstall = null;
window.addEventListener("beforeinstallprompt", function (e) {
  e.preventDefault(); window.vyraInstall = e;
  document.dispatchEvent(new CustomEvent("vyra-installable"));
});
window.addEventListener("appinstalled", function () { window.vyraInstall = null; document.dispatchEvent(new CustomEvent("vyra-installed")); });
if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () { navigator.serviceWorker.register("/sw.js").catch(function () {}); });
}
