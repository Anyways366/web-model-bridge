var apiUrl = window.location.origin + '/v1';
document.getElementById('api-url').textContent = apiUrl;

function esc(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

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
    list.innerHTML = '';
    data.providers.forEach(function(p) {
      var card = document.createElement('div');
      card.className = 'provider-card ' + (p.authenticated ? 'active' : 'inactive');

      var info = document.createElement('div');
      info.className = 'provider-info';

      var dot = document.createElement('span');
      dot.className = 'status-dot ' + (p.authenticated ? 'green' : 'red');
      info.appendChild(dot);

      var name = document.createElement('strong');
      name.textContent = p.name;
      info.appendChild(name);

      var pid = document.createElement('span');
      pid.className = 'provider-id';
      pid.textContent = p.id;
      info.appendChild(pid);

      card.appendChild(info);

      var action = document.createElement('div');
      action.className = 'provider-action';

      if (p.authenticated) {
        var mc = document.createElement('span');
        mc.className = 'model-count';
        mc.textContent = p.modelCount + ' models';
        action.appendChild(mc);
      } else {
        var btn = document.createElement('button');
        btn.className = 'login-btn';
        btn.textContent = 'Login';
        btn.addEventListener('click', function() { loginProvider(p.id); });
        action.appendChild(btn);
      }

      card.appendChild(action);
      list.appendChild(card);
    });
  } catch (err) {
    document.getElementById('provider-list').innerHTML =
      '<p class="error">Failed to load: ' + esc(err.message) + '</p>';
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

    el.innerHTML = '';
    var grid = document.createElement('div');
    grid.className = 'health-grid';

    var statusItem = document.createElement('div');
    statusItem.className = 'health-item';
    var sl = document.createElement('span');
    sl.className = 'health-label';
    sl.textContent = 'Status';
    var sv = document.createElement('span');
    sv.className = 'health-value ' + esc(data.status);
    sv.textContent = data.status;
    statusItem.appendChild(sl);
    statusItem.appendChild(sv);

    var uptimeItem = document.createElement('div');
    uptimeItem.className = 'health-item';
    var ul = document.createElement('span');
    ul.className = 'health-label';
    ul.textContent = 'Uptime';
    var uv = document.createElement('span');
    uv.className = 'health-value';
    uv.textContent = uptime;
    uptimeItem.appendChild(ul);
    uptimeItem.appendChild(uv);

    grid.appendChild(statusItem);
    grid.appendChild(uptimeItem);
    el.appendChild(grid);
  } catch (e) {
    document.getElementById('health-info').innerHTML = '<p class="error">Unable to reach server</p>';
  }
}

loadProviders();
loadHealth();
setInterval(function() { loadProviders(); loadHealth(); }, 10000);
