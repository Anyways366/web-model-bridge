var origin = window.location.origin;
document.getElementById('openai-url').textContent = origin + '/v1';
document.getElementById('anthropic-url').textContent = origin;

// Toast notification
function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function () {
    t.classList.remove('show');
  }, 2000);
}

// Copy URL — uses data-target attribute instead of inline onclick
function copyText(targetId) {
  var text = document.getElementById(targetId).textContent;
  navigator.clipboard.writeText(text).then(function () {
    showToast('Copied to clipboard!');
  });
}

// Bind copy buttons via data-target (no inline handlers)
document.querySelectorAll('.btn-copy[data-target]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    copyText(btn.getAttribute('data-target'));
  });
});

// Load providers list
async function loadProviders() {
  try {
    var res = await fetch('/webmodel/providers');
    var data = await res.json();
    var list = document.getElementById('provider-list');
    var countEl = document.getElementById('provider-count');

    if (!data.providers || data.providers.length === 0) {
      list.textContent = '';
      var emptyDiv = document.createElement('div');
      emptyDiv.className = 'empty';
      emptyDiv.textContent = 'No providers configured.';
      list.appendChild(emptyDiv);
      countEl.textContent = '0 / 0';
      return;
    }

    var authCount = data.providers.filter(function (p) {
      return p.authenticated;
    }).length;
    countEl.textContent = authCount + ' / ' + data.providers.length + ' active';

    list.textContent = '';

    data.providers.forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'provider-row';

      var left = document.createElement('div');
      left.className = 'provider-left';

      var dot = document.createElement('div');
      dot.className =
        'status-indicator ' + (p.authenticated ? 'active' : 'inactive');
      left.appendChild(dot);

      var nameEl = document.createElement('span');
      nameEl.className = 'provider-name';
      nameEl.textContent = p.name;
      left.appendChild(nameEl);

      var idEl = document.createElement('span');
      idEl.className = 'provider-id';
      idEl.textContent = p.id;
      left.appendChild(idEl);

      row.appendChild(left);

      var right = document.createElement('div');
      right.className = 'provider-right';

      if (p.authenticated) {
        var badge = document.createElement('span');
        badge.className = 'model-badge';
        badge.textContent = p.modelCount + ' models';
        right.appendChild(badge);
      } else {
        var btn = document.createElement('button');
        btn.className = 'btn-login';
        btn.textContent = 'Login';
        btn.addEventListener('click', function () {
          loginProvider(p.id);
        });
        right.appendChild(btn);
      }

      row.appendChild(right);
      list.appendChild(row);
    });
  } catch (err) {
    var list = document.getElementById('provider-list');
    list.textContent = '';
    var errDiv = document.createElement('div');
    errDiv.className = 'error';
    errDiv.textContent = 'Failed to load: ' + err.message;
    list.appendChild(errDiv);
  }
}

// Login flow
async function loginProvider(providerId) {
  try {
    showToast('Launching Chrome for ' + providerId + '...');
    var res = await fetch('/webmodel/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: providerId }),
    });
    var data = await res.json();
    if (data.status === 'login_started') {
      showToast(data.message || 'Chrome window opened. Please log in.');
      pollLoginStatus(providerId);
    } else if (data.status === 'error' || data.error) {
      showToast(data.message || data.error || 'Login failed');
    }
  } catch (err) {
    showToast('Login failed: ' + err.message);
  }
}

// Poll login status endpoint for real-time feedback
function pollLoginStatus(providerId) {
  var interval = setInterval(async function () {
    try {
      // Check login-status for detailed progress
      var statusRes = await fetch('/webmodel/auth/login-status');
      var statusData = await statusRes.json();
      if (statusData.status === 'waiting_for_user') {
        showToast('Waiting for you to log in at the Chrome window...');
      } else if (statusData.status === 'success') {
        clearInterval(interval);
        showToast(providerId + ' login completed!');
        loadProviders();
        loadHealth();
        return;
      } else if (statusData.status === 'failed') {
        clearInterval(interval);
        showToast('Login failed: ' + statusData.message);
        return;
      }

      // Also check provider status as backup
      var res = await fetch('/webmodel/providers');
      var data = await res.json();
      var provider = data.providers.find(function (p) {
        return p.id === providerId;
      });
      if (provider && provider.authenticated) {
        clearInterval(interval);
        showToast(providerId + ' authenticated!');
        loadProviders();
        loadHealth();
      }
    } catch (e) {
      /* retry */
    }
  }, 2000);
  setTimeout(function () {
    clearInterval(interval);
  }, 120000);
}

// Load system health stats
async function loadHealth() {
  try {
    var res = await fetch('/webmodel/health');
    var data = await res.json();
    var el = document.getElementById('health-info');

    var seconds = data.uptime || 0;
    var uptime =
      seconds < 60
        ? seconds + 's'
        : seconds < 3600
          ? Math.floor(seconds / 60) + 'm'
          : Math.floor(seconds / 3600) +
            'h ' +
            Math.floor((seconds % 3600) / 60) +
            'm';

    var browserStatus = data.browser ? data.browser.status : 'unknown';

    el.textContent = '';

    var items = [
      {
        label: 'Status',
        value: data.status || 'unknown',
        cls: data.status === 'healthy' ? 'green' : '',
      },
      { label: 'Uptime', value: uptime, cls: '' },
      {
        label: 'Browser',
        value: browserStatus,
        cls: browserStatus === 'running' ? 'green' : '',
      },
    ];

    items.forEach(function (item) {
      var div = document.createElement('div');
      div.className = 'stat-item';

      var label = document.createElement('span');
      label.className = 'stat-label';
      label.textContent = item.label;
      div.appendChild(label);

      var val = document.createElement('span');
      val.className = 'stat-value' + (item.cls ? ' ' + item.cls : '');
      val.textContent = item.value;
      div.appendChild(val);

      el.appendChild(div);
    });
  } catch (e) {
    var el = document.getElementById('health-info');
    el.textContent = '';
    var errDiv = document.createElement('div');
    errDiv.className = 'error';
    errDiv.textContent = 'Unable to reach server';
    el.appendChild(errDiv);
  }
}

// Initial load + auto-refresh every 10s
loadProviders();
loadHealth();
setInterval(function () {
  loadProviders();
  loadHealth();
}, 10000);
