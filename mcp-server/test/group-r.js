const { assert, test } = require("./harness.js");
const bridge = require("../bridge.js");

// Bridge envelope construction. These test the pure _buildEnvelope helper
// rather than the full sendCommand path (which requires a live WebSocket).
async function groupR() {
  console.log("\nR. bridge envelope construction");

  // N4: tool params may contain _client, id, or action (reserved envelope keys
  // that the extension or the bridge use for routing). Spreading them into the
  // outgoing envelope lets a caller spoof the client identity or hijack routing.
  await test("R1 reserved keys in tool params are stripped before sending", () => {
    const env = bridge._buildEnvelope(
      "navigate",
      { url: "http://x.com/", _client: "spoofed", id: "hijack", action: "evil" },
      null,
    );
    assert.strictEqual(env.action, "navigate", "action was overwritten by params");
    assert.ok(env._client !== "spoofed", "_client from params leaked into envelope");
    assert.ok(env.id !== "hijack", "id from params leaked into envelope");
    assert.strictEqual(env.url, "http://x.com/", "legitimate param was stripped");
  });

  // S3: when a Secondary is promoted to Primary, isSecondary flips to false but
  // nodeId keeps the agent's UUID. Without stamping _client, the agent's commands
  // go to the extension with no _client and the extension keys them as "primary",
  // inheriting the dead Primary's pointer instead of the promoted agent's own.
  await test("R2 a promoted secondary stamps its nodeId as _client", () => {
    const env = bridge._buildEnvelope("navigate", { url: "http://x.com/" }, "promoted-uuid");
    assert.strictEqual(env._client, "promoted-uuid", "nodeId not stamped as _client");
  });
}

module.exports = groupR;
