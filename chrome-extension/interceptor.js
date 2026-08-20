// Intercepts GraphQL and API requests in the MAIN world to bypass DOM obfuscation
// and virtualization, passing the raw JSON data to the content script.

(() => {
  let interceptPatterns = ["graphql", "/api/", "voyager", "feed"];

  window.addEventListener("message", (event) => {
    if (event.data && event.data.type === "ZC_UPDATE_PATTERNS") {
      if (Array.isArray(event.data.patterns)) {
        interceptPatterns = event.data.patterns;
        console.log(
          "[PolterTab Interceptor] Updated patterns:",
          interceptPatterns,
        );
      }
    }
  });

  const originalFetch = window.fetch;

  window.fetch = async (...args) => {
    const response = await originalFetch(...args);

    try {
      const url =
        typeof args[0] === "string"
          ? args[0]
          : args[0] && args[0].url
            ? args[0].url
            : "";

      // Look for LinkedIn GraphQL queries or general API endpoints
      if (interceptPatterns.some((p) => url.includes(p))) {
        const clone = response.clone();
        clone
          .text()
          .then((body) => {
            window.postMessage(
              {
                type: "ZC_NETWORK_DATA",
                url: url,
                body: body,
              },
              "*",
            );
          })
          .catch((err) => {
            console.error(
              "[PolterTab Interceptor] Failed to read fetch clone body:",
              err,
            );
          });
      }
    } catch (err) {
      console.error("[PolterTab Interceptor] Error processing fetch:", err);
    }

    return response;
  };

  // Optional: Also override XMLHttpRequest if older APIs are used
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._url = url;
    return originalXhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...body) {
    this.addEventListener("load", function () {
      if (this._url && interceptPatterns.some((p) => this._url.includes(p))) {
        try {
          window.postMessage(
            {
              type: "ZC_NETWORK_DATA",
              url: this._url,
              body: this.responseText,
            },
            "*",
          );
        } catch (err) {
          console.error("[PolterTab Interceptor] Error processing XHR:", err);
        }
      }
    });
    return originalXhrSend.apply(this, body);
  };

  console.log("[PolterTab] Network interceptor injected into MAIN world.");
  window.postMessage(
    { type: "ZC_NETWORK_DATA", url: "TEST_INIT", body: "Interceptor loaded" },
    "*",
  );
})();
