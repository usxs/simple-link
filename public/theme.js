(function () {
  var KEY = 'simple-link-theme';
  var root = document.documentElement;
  var media = window.matchMedia('(prefers-color-scheme: dark)');
  var valid = { auto: true, light: true, dark: true };
  var mode = 'auto';

  try {
    var saved = localStorage.getItem(KEY);
    if (saved && valid[saved]) mode = saved;
  } catch (error) {
    /* localStorage 不可用时跟随系统 */
  }

  function paint() {
    var dark = mode === 'dark' || (mode === 'auto' && media.matches);
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    root.setAttribute('data-theme-mode', mode);
    var buttons = document.querySelectorAll('.theme-option[data-theme-mode]');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].setAttribute('aria-pressed', String(buttons[i].getAttribute('data-theme-mode') === mode));
    }
  }

  function apply(next) {
    mode = valid[next] ? next : 'auto';
    paint();
  }

  paint();

  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', function () {
      if (mode === 'auto') paint();
    });
  }

  function bind() {
    var buttons = document.querySelectorAll('.theme-option[data-theme-mode]');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].addEventListener('click', function () {
        var next = this.getAttribute('data-theme-mode');
        try {
          localStorage.setItem(KEY, next);
        } catch (error) {
          /* 忽略 */
        }
        apply(next);
      });
    }
    paint();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
