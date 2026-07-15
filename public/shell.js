/* Shared app chrome — new-fs visual. Flows/API/IDs unchanged.
   Usage: <div id="app" class="app"><div class="col"><main class="scroll">…</main></div></div>
   then mountShell('dashboard','Dashboard') or mountShell('new-return','New Return',{topbarRightHtml:'…'}). */
(function () {
  var ICON = {
    dashboard:
      '<rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.2"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1.2"/><rect x="1.5" y="9" width="5.5" height="5.5" rx="1.2"/><rect x="9" y="9" width="5.5" height="5.5" rx="1.2"/>',
    'new-return':
      '<path d="M8 10.5V2.5"/><path d="M4.5 5.5L8 2l3.5 3.5"/><path d="M2 10.5v2A1.5 1.5 0 003.5 14h9a1.5 1.5 0 001.5-1.5v-2"/>',
    returns:
      '<path d="M4 3.5h6.5L14 7v9.5A1.5 1.5 0 0112.5 18h-8.5A1.5 1.5 0 012.5 16.5v-11.5A1.5 1.5 0 014 3.5z"/><path d="M10.5 3.5V7H14"/>',
  };
  var NAV = [
    ['dashboard', 'Dashboard', '/dashboard'],
    ['new-return', 'New Return', '/new-return'],
    ['returns', 'Returns', '/dashboard'],
  ];
  var MOBILE_MQ = '(max-width: 900px)';

  function svg(p) {
    return (
      '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      p +
      '</svg>'
    );
  }
  function links(active) {
    return (
      '<div class="sb-sep collapsible">Overview</div>' +
      NAV.map(function (n) {
        var on = n[0] === active;
        return (
          '<a class="sb-link' +
          (on ? ' on' : '') +
          '" href="' +
          n[2] +
          '">' +
          svg(ICON[n[0]]) +
          '<span class="collapsible">' +
          n[1] +
          '</span></a>'
        );
      }).join('')
    );
  }

  window.mountShell = function (active, title, opts) {
    opts = opts || {};
    var app = document.getElementById('app');
    if (!app) return;

    var sidebar =
      '<button type="button" class="sb-backdrop" id="sbBackdrop" aria-label="Close menu" tabindex="-1"></button>' +
      '<aside class="sidebar" id="sidebar">' +
      '<div class="glow"></div>' +
      '<div class="sb-logo"><img src="/assets/vacei-logo.png" alt="Vacei"/>' +
      '<span class="wm collapsible">Malta Tax <b>AI</b></span></div>' +
      '<div class="sb-company collapsible"><div style="min-width:0">' +
      '<div class="nm u-email">Signed in</div>' +
      '<div class="meta">Corporate tax returns</div></div></div>' +
      '<nav class="sb-nav sbhide">' +
      links(active) +
      '</nav>' +
      '<div class="sb-foot"><div class="sb-user">' +
      '<div class="row"><div class="av u-av">V</div><div class="collapsible" style="overflow:hidden;min-width:0">' +
      '<p class="nm u-name">Your account</p><p class="em u-email">—</p></div></div>' +
      '<a href="/login" class="sb-logout logout-link" title="Logout">' +
      '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">' +
      '<path d="M6 2.5H3.5A1.5 1.5 0 002 4v8a1.5 1.5 0 001.5 1.5H6"/><path d="M10.5 11.5L14 8l-3.5-3.5"/><path d="M14 8H6"/></svg>' +
      '<span class="logout-label collapsible">Logout</span></a>' +
      '</div></div></aside>';

    var right =
      opts.topbarRightHtml ||
      '<span class="status-active hide-sm">ACTIVE</span>' +
        '<a href="/new-return" class="shell-credits">Free returns: <span class="u-credits">—</span></a>' +
        '<a href="/new-return" class="btn btn-primary" style="padding:8px 16px;font-size:13px">+ New return</a>' +
        '<div class="userchip" title=""><div class="av u-av">V</div></div>';

    var header =
      '<header class="topbar">' +
      '<div class="topbar-left">' +
      '<button type="button" class="icon-btn" id="sbToggle" title="Toggle menu">← Menu</button>' +
      '<div class="topbar-meta">' +
      '<div class="eyebrow">MALTA TAX · ENGAGEMENT</div>' +
      '<h1>' +
      title +
      '</h1></div></div>' +
      '<div class="topbar-right">' +
      right +
      '</div></header>';

    var col = app.querySelector('.col');
    app.insertAdjacentHTML('afterbegin', sidebar);
    if (col) {
      var pane = col.querySelector('.pane');
      if (!pane) {
        pane = document.createElement('div');
        pane.className = 'pane';
        while (col.firstChild) pane.appendChild(col.firstChild);
        col.appendChild(pane);
      }
      pane.insertAdjacentHTML('afterbegin', header);
    }

    var sb = document.getElementById('sidebar');
    var tg = document.getElementById('sbToggle');
    var backdrop = document.getElementById('sbBackdrop');
    var collapsed = false;
    var mobileOpen = false;

    function isMobile() {
      return window.matchMedia(MOBILE_MQ).matches;
    }
    function applyNavState() {
      if (!sb) return;
      if (isMobile()) {
        sb.classList.remove('collapsed', 'mini');
        sb.classList.toggle('mobile-open', mobileOpen);
        app.classList.toggle('mobile-nav-open', mobileOpen);
      } else {
        sb.classList.remove('mobile-open');
        app.classList.remove('mobile-nav-open');
        sb.classList.toggle('collapsed', collapsed);
        sb.classList.toggle('mini', collapsed);
      }
      if (tg) {
        if (isMobile()) tg.textContent = mobileOpen ? '✕ Close' : '☰ Menu';
        else tg.textContent = collapsed ? '→ Expand' : '← Menu';
      }
    }
    if (tg) {
      tg.onclick = function () {
        if (isMobile()) mobileOpen = !mobileOpen;
        else collapsed = !collapsed;
        applyNavState();
      };
    }
    if (backdrop) {
      backdrop.onclick = function () {
        mobileOpen = false;
        applyNavState();
      };
    }
    window.addEventListener('resize', function () {
      if (!isMobile()) mobileOpen = false;
      applyNavState();
    });
    applyNavState();
  };
})();
