// Types for what tests import from the dependency-free MCP server (mcp/bugme.mjs).
export function parseMcpList(out: string): { name: string; prefix: string; status: string }[];
export function skillNames(): string[];
