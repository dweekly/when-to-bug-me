// Types for what tests import from the dependency-free hook script (mcp/bugme-hook.mjs).
export const DEADLINE_MS: number;
export function hookBody(payload: unknown): Record<string, unknown> | null;
