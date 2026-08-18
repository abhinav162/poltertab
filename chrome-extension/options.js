// Load current setting
chrome.storage.local.get(["wsPort"], (result) => {
  document.getElementById("wsPort").value = result.wsPort || 7822;
});

// Save setting
document.getElementById("saveBtn").addEventListener("click", () => {
  const port = parseInt(document.getElementById("wsPort").value, 10);
  if (Number.isNaN(port) || port < 1024 || port > 65535) {
    alert("Please enter a valid port between 1024 and 65535");
    return;
  }

  chrome.storage.local.set({ wsPort: port }, () => {
    const status = document.getElementById("status");
    status.textContent = "Options saved.";
    setTimeout(() => {
      status.textContent = "";
    }, 2000);
  });
});
