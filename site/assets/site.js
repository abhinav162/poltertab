// PolterTab site: copy buttons, mobile menu, scene play/pause. Progressive
// enhancement only; the page reads and works with this file absent.
// Copy-to-clipboard for the install commands.
document.querySelectorAll('.copy-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var target = document.querySelector(btn.getAttribute('data-copy'));
    if (!target || !navigator.clipboard) return;
    navigator.clipboard.writeText(target.textContent).then(function () {
      var prev = btn.textContent, cmd = btn.closest('.cmd');
      btn.textContent = '\u2713 Copied';
      btn.classList.add('is-copied');
      if (cmd) cmd.classList.add('is-flash');
      setTimeout(function () {
        btn.textContent = prev;
        btn.classList.remove('is-copied');
        if (cmd) cmd.classList.remove('is-flash');
      }, 1600);
    });
  });
});

// Mobile menu.
(function () {
  var toggle = document.querySelector('.nav-toggle'), sheet = document.getElementById('nav-sheet');
  if (!toggle || !sheet) return;
  function set(open) {
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    sheet.classList.toggle('open', open);
  }
  toggle.addEventListener('click', function () { set(toggle.getAttribute('aria-expanded') !== 'true'); });
  document.addEventListener('click', function (e) { if (sheet.classList.contains('open') && !sheet.contains(e.target) && !toggle.contains(e.target)) set(false); });
  sheet.querySelectorAll('a').forEach(function (a) { a.addEventListener('click', function () { set(false); }); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && sheet.classList.contains('open')) { set(false); toggle.focus(); } });
})();

// Each scene plays while it is on screen and pauses when it leaves, so the
// loops start in sync with the reader and cost nothing off screen. Without
// IntersectionObserver every scene simply runs.
(function () {
  var scenes = document.querySelectorAll('.scene');
  if (!('IntersectionObserver' in window)) { scenes.forEach(function (s) { s.classList.add('play'); }); return; }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { e.target.classList.toggle('play', e.isIntersecting); });
  }, { threshold: 0.25 });
  scenes.forEach(function (s) { io.observe(s); });
})();
