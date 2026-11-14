// classic script on purpose: reveals and copy buttons work even if the module scene (three, WebGL) fails
(function () {
  var els = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches) { els.forEach(function (e) { e.classList.add("in"); }); }
  else { var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }); }, { rootMargin: "0px 0px -10% 0px" }); els.forEach(function (e) { io.observe(e); }); }

  document.querySelectorAll(".copy").forEach(function (b) {
    b.addEventListener("click", function () {
      var t = document.querySelector(b.dataset.copy).textContent.replace(/\s+/g, " ").trim();
      navigator.clipboard.writeText(t).then(function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 1500); }, function () { b.textContent = "Select and copy"; });
    });
  });
})();
