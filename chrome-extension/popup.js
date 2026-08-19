document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('conn-status');
  const listEl = document.getElementById('session-list');
  const refreshBtn = document.getElementById('refreshBtn');
  const optionsBtn = document.getElementById('optionsBtn');

  function updateUI(state) {
    // Update status
    statusEl.textContent = state.connected ? 'Connected' : 'Disconnected';
    statusEl.className = 'status ' + (state.connected ? 'connected' : 'disconnected');

    // Update list
    listEl.textContent = '';
    const sessions = state.sessions || [];
    
    if (sessions.length === 0) {
      const div = document.createElement('div');
      div.className = 'empty-state';
      div.textContent = 'No active agents';
      listEl.appendChild(div);
      return;
    }

    sessions.forEach(session => {
      const li = document.createElement('li');
      li.className = 'session-item';
      
      const nameSpan = document.createElement('span');
      nameSpan.className = 'session-name';
      nameSpan.textContent = session.id || 'Unknown Agent';
      
      const metaSpan = document.createElement('span');
      metaSpan.className = 'session-meta';
      metaSpan.textContent = `Node: ${session.nodeId || 'N/A'}`;
      if (session.lastTabId) {
         metaSpan.textContent += ` | Tab: ${session.lastTabId}`;
      }
      
      li.appendChild(nameSpan);
      li.appendChild(metaSpan);
      listEl.appendChild(li);
    });
  }

  function fetchStatus() {
    chrome.runtime.sendMessage({ type: "get_status" }, (response) => {
      if (chrome.runtime.lastError) {
        statusEl.textContent = 'Error';
        statusEl.className = 'status disconnected';
        const div = document.createElement('div');
        div.className = 'empty-state';
        div.textContent = 'Failed to reach background script.';
        listEl.textContent = '';
        listEl.appendChild(div);
        return;
      }
      if (response) {
        updateUI(response);
      }
    });
  }

  refreshBtn.addEventListener('click', () => {
    // Force a fresh request to primary if connected
    chrome.runtime.sendMessage({ type: "force_refresh" }, (response) => {
      if (response) updateUI(response);
    });
  });

  optionsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Initial fetch
  fetchStatus();
  
  // Listen for broadcast updates from background.js
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "state_update") {
      updateUI(msg.state);
    }
  });
});
