const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

async function main() {
  console.log("Starting MCP client...");
  
  const transport = new StdioClientTransport({
    command: process.execPath, // node
    args: ["index.js"]
  });

  const client = new Client({
    name: "test-client",
    version: "1.0.0"
  }, {
    capabilities: {}
  });

  await client.connect(transport);
  console.log("Connected to MCP server.");

  try {
    const result = await client.callTool({
      name: "browser_get_title",
      arguments: {}
    });
    console.log("Tool result:", JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("Tool execution failed:", err);
  } finally {
    // Close and exit
    process.exit(0);
  }
}

main().catch(err => {
  console.error("Client error:", err);
  process.exit(1);
});