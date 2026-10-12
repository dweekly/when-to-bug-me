// Whether this page is the owner's live queue (/me, docs/STAGE-7.md) rather than the simulation.
// Its own module with no imports, so state.ts and api.ts can read it without a cycle.
export const OWNER_PAGE = typeof location !== "undefined" && location.pathname === "/me";
