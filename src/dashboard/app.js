const apiUrl = window.location.origin + '/v1';
document.getElementById('api-url').textContent = apiUrl;

async function copyUrl() {
  await navigator.clipboard.writeText(apiUrl);
  var btn = document.getElementById('copy-btn');
  btn.textContent = 'Copied!';
  setTimeout(function() { btn.textContent = 'Copy'; }, 2000);
}

async function loadProviders() {
  try {
    var res = await fetch('/webmodel/providers');
    var data = await res.json();
    var list = document.getElementById('provider-list');
    if (!data.providers || data.providers.length === 0) {
      list.innerHTML = '<p class="empty">No providers configured.</p>';
      return;
    }
    list.innerHTML = data.providers.map(function(p) {
      return '<div class="provider-card ' + (p.authenticated ? 'active' : 'inactive') + '">' +
        '<div class="provider-info">' +
        '<span class="status-dot ' + (p.authenticated ? 'green' : 'red') + '"></span>' +
        '<strong>' + p.name + '</strong>' +
        '<span class="provider-id">' + p.id + '</span>' +
        '</div>' +
        '<div class="provider-action">' +
        (p.authenticated
          ? '<span class="model-count">' + p.modelCount + ' models</span>'
          : '<button onclick="loginProvider(\'' + p.id + '\')" class="login-btn">Login</button>') +
        '</div></div>';
    }).join('');
  } catch (err) {
    document.getElementById('provider-list').innerHTML =
      '<p class="error">Failed to load: ' + err.message + '</p>';
  }
}

async function loginProvider(providerId) {
  try {
    var res = await fetch('/webmodel/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: providerId }),
    });
    var data = await res.json();
    if (data.status === 'login_started') {
      alert('Login window opened for ' + providerId + '. Complete login in the browser window.');
      pollLogin(providerId);
    }
  } catch (err) {
    alert('Login failed: ' + err.message);
  }
}

function pollLogin(providerId) {
  var interval = setInterval(async function() {
    var res = await fetch('/webmodel/providers');
    var data = await res.json();
    var provider = data.providers.find(function(p) { return p.id === providerId; });
    if (provider && provider.authenticated) {
      clearInterval(interval);
      loadProviders();
      loadHealth();
    }
  }, 2000);
  setTimeout(function() { clearInterval(interval); }, 120000);
}

async function loadHealth() {
  try {
    var res = await fetch('/webmodel/health');
    var data = await res.json();
    var el = document.getElementById('health-info');
    var seconds = data.uptime;
    var uptime = seconds < 60 ? seconds + 's' :
      seconds < 3600 ? Math.floor(seconds / 60) + 'm' :
      Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
    el.innerHTML =
      '<div class="health-grid">' +
      '<div class="health-item"><span class="health-label">Status</span><span class="health-value ' + data.status + '">' + data.status + '</span></div>' +
      '<div class="health-item"><span class="health-label">Uptime</span><span class="health-value">' + uptime + '</span></div>' +
      '</div>';
  } catch (e) {
    document.getElementById('health-info').innerHTML = '<p class="error">Unable to reach server</p>';
  }
}

loadProviders();
loadHealth();
setInterval(function() { loadProviders(); loadHealth(); }, 10000);
