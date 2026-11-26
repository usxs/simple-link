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

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function syncFavicon(dark) {
    var link = document.getElementById('theme-favicon');
    if (!link) return;
    var canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    var ctx = canvas.getContext('2d');
    var bg = dark ? '#FFFFFF' : '#18181B';
    var fg = dark ? '#18181B' : '#F4F4F5';
    ctx.fillStyle = bg;
    roundRect(ctx, 0, 0, 128, 128, 26);
    ctx.fill();
    var brand = document.documentElement.getAttribute('data-brand') || 'mail';
    ctx.strokeStyle = fg;
    ctx.fillStyle = fg;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (brand === 'url') {
      ctx.save();
      ctx.translate(64, 64);
      ctx.scale(2.6, 2.6);
      ctx.translate(-32, -32);
      ctx.lineWidth = 4.6;
      ctx.stroke(new Path2D('M25 39 39 25 M27.5 22.5h-3a8.5 8.5 0 0 0 0 17h3 M36.5 22.5h3a8.5 8.5 0 0 1 0 17h-3'));
      ctx.restore();
    } else {
      ctx.lineWidth = 8;
      roundRect(ctx, 20, 32, 88, 64, 10);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(23, 37);
      ctx.lineTo(64, 70);
      ctx.lineTo(105, 37);
      ctx.stroke();
    }
    link.type = 'image/png';
    link.href = canvas.toDataURL('image/png');
  }

  function paint() {
    var dark = mode === 'dark' || (mode === 'auto' && media.matches);
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    root.setAttribute('data-theme-mode', mode);
    root.style.colorScheme = dark ? 'dark' : 'light';
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', dark ? 'dark' : 'light');
    syncFavicon(dark);
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
